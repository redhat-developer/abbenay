/**
 * Daemon lifecycle management
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  getDefaultSocketPath,
  ensureSocketDir,
  cleanupSocket,
  writePidFile,
  removePidFile,
  readPidFile,
  isDaemonRunningSync,
  killDaemon,
  isProcessRunning,
} from './transport.js';
import { DaemonState } from './state.js';
import { createAbbenayService } from './server/abbenay-service.js';
import { stopEmbeddedWebServer } from './web/server.js';

export type { DaemonState };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the proto file path. Checks multiple locations:
 *  1) ABBENAY_PROTO_DIR env var (explicit override)
 *  2) Next to the current file: __dirname/proto/  (esbuild bundle)
 *  3) Monorepo layout: __dirname/../../../proto/  (development from dist/)
 */
function resolveProtoPath(): { protoFile: string; includeDir: string } {
  const candidates = [
    process.env.ABBENAY_PROTO_DIR,
    path.resolve(__dirname, 'proto'),
    path.resolve(__dirname, '../../../../proto'),
  ].filter(Boolean) as string[];
  
  for (const dir of candidates) {
    const file = path.join(dir, 'abbenay', 'v1', 'service.proto');
    if (fs.existsSync(file)) {
      return { protoFile: file, includeDir: dir };
    }
  }
  
  throw new Error(
    `Proto file not found. Searched:\n` +
    candidates.map(d => `  - ${path.join(d, 'abbenay/v1/service.proto')}`).join('\n')
  );
}

const { protoFile: PROTO_PATH, includeDir: PROTO_INCLUDE } = resolveProtoPath();

let server: grpc.Server | null = null;
let state: DaemonState | null = null;

/**
 * Load proto definitions
 */
function loadProto() {
  if (!fs.existsSync(PROTO_PATH)) {
    throw new Error(`Proto file not found: ${PROTO_PATH}`);
  }
  
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_INCLUDE],
  });
  
  return grpc.loadPackageDefinition(packageDefinition);
}

export interface DaemonOptions {
  keepAlive?: boolean;
  /** When set, also bind gRPC to this TCP port. */
  grpcPort?: number;
  /** Host/IP to bind the TCP gRPC listener to (default: 127.0.0.1). */
  grpcHost?: string;
}

/**
 * Start the daemon (gRPC server only, no web).
 * Returns the DaemonState for callers that need it (e.g. `abbenay web` in-process mode).
 */
export async function startDaemon(opts?: DaemonOptions): Promise<DaemonState> {
  // Check if already running
  if (isDaemonRunningSync()) {
    throw new Error('Abbenay daemon is already running');
  }
  
  console.log('Starting Abbenay daemon...');
  
  // Ensure directories exist
  ensureSocketDir();
  
  // Clean up stale socket
  cleanupSocket();
  
  // Write PID file
  writePidFile();
  
  // Create state
  state = new DaemonState();
  
  // Load proto and create server
  const proto = loadProto();
  const abbenayProto = (proto as unknown as { abbenay: { v1: { Abbenay: { service: grpc.ServiceDefinition } } } }).abbenay.v1;
  
  server = new grpc.Server();
  
  // Add Abbenay service
  const abbenayService = createAbbenayService(state);
  server.addService(abbenayProto.Abbenay.service, abbenayService);
  
  const socketPath = getDefaultSocketPath();

  try {
    // Bind to Unix socket
    await new Promise<void>((resolve, reject) => {
      server!.bindAsync(
        `unix://${socketPath}`,
        grpc.ServerCredentials.createInsecure(),
        (error, _port) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
    
    console.log(`Abbenay daemon listening on ${socketPath}`);

    // Optionally bind gRPC to a TCP port for remote / container access
    if (opts?.grpcPort) {
      const grpcHost = opts.grpcHost ?? '127.0.0.1';

      if (grpcHost === '0.0.0.0') {
        console.warn(
          '[Daemon] WARNING: gRPC is bound to 0.0.0.0 — the API is accessible from ' +
          'any network interface. Ensure a consumers section is configured in config.yaml ' +
          'to require authentication, or use --grpc-host 127.0.0.1 to restrict access.',
        );
      }

      await new Promise<void>((resolve, reject) => {
        server!.bindAsync(
          `${grpcHost}:${opts.grpcPort}`,
          grpc.ServerCredentials.createInsecure(),
          (error, boundPort) => {
            if (error) {
              reject(error);
            } else {
              console.log(`Abbenay gRPC listening on ${grpcHost}:${boundPort}`);
              resolve();
            }
          }
        );
      });
    }
  } catch (err) {
    // Clean up PID file, socket, and server on bind failure
    await new Promise<void>((resolve) => {
      server!.tryShutdown(() => resolve());
    });
    server = null;
    cleanupSocket();
    removePidFile();
    state = null;
    throw err;
  }

  console.log(`Version: ${state.version}`);
  
  // Initialize MCP connections from config (non-blocking)
  state.initMcpConnections().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Daemon] MCP initialization error:', msg);
  });
  
  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await state!.mcpClientPool.disconnectAll().catch(() => {});
    await stopEmbeddedWebServer();
    await stopDaemonInternal();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  // If keepAlive is not explicitly false, block forever (default daemon mode)
  if (opts?.keepAlive !== false) {
    console.log('Press Ctrl+C to stop');
    await new Promise(() => {});
  }
  
  return state;
}

/**
 * Get the current DaemonState (if daemon is running in-process).
 */
export function getDaemonState(): DaemonState | null {
  return state;
}

/**
 * Internal shutdown (when running in-process)
 */
async function stopDaemonInternal(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.tryShutdown(() => {
        resolve();
      });
    });
    server = null;
  }
  
  cleanupSocket();
  removePidFile();
  state = null;
}

/**
 * Stop external daemon
 */
export async function stopDaemon(): Promise<void> {
  const pid = readPidFile();
  
  if (!pid) {
    // No PID file, but maybe stale socket exists
    cleanupSocket();
    throw new Error('No daemon PID file found');
  }
  
  if (!isProcessRunning(pid)) {
    // Process not running, clean up
    removePidFile();
    cleanupSocket();
    throw new Error('Daemon process not running (cleaned up stale files)');
  }
  
  // Kill the process
  const killed = killDaemon();
  
  if (killed) {
    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    // Clean up files if process didn't
    removePidFile();
    cleanupSocket();
  } else {
    throw new Error('Failed to stop daemon');
  }
}

/**
 * Get daemon status
 */
export function getDaemonStatus(): { 
  running: boolean; 
  pid: number | null; 
  socketPath: string;
} {
  const pid = readPidFile();
  const socketPath = getDefaultSocketPath();
  
  if (pid && isProcessRunning(pid)) {
    return { running: true, pid, socketPath };
  }
  
  return { running: false, pid: null, socketPath };
}
