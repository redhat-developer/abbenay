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
  ensureRuntimeDir,
  cleanupSocket,
  cleanupIpcArtifacts,
  writePidFile,
  removePidFile,
  readPidFile,
  writeAddressFile,
  readAddressFile,
  isDaemonRunningSync,
  killDaemon,
  isProcessRunning,
} from './transport.js';
import { DaemonState } from './state.js';
import { createAbbenayService } from './server/abbenay-service.js';
import {
  assertConsumersConfiguredForBind,
  buildConsumerAuthContext,
  hasConfiguredConsumers,
  resolveAllowOpenAuth,
} from './server/consumer-auth.js';import { stopEmbeddedWebServer } from './web/server.js';
import { loadConfig } from '../core/config.js';
import {
  resolveTcpGrpcBind,
  type GrpcTlsOptions,
} from './grpc-tls.js';

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
  /**
   * Expected HTTP/web port for self-connection detection.
   * Set even before the web server binds so MCP init cannot recurse into /mcp.
   */
  httpPort?: number;
  /** TLS / insecure bind options for the TCP gRPC listener. */
  grpcTls?: GrpcTlsOptions;
  /**
   * Explicit open consumer auth (`--allow-open-auth`).
   * Also implied by `--insecure` / `ABBENAY_ALLOW_OPEN_AUTH`.
   */
  allowOpenAuth?: boolean;
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

  // AI SDK telemetry (DR-042) — once per process
  const { initAiSdkTelemetry } = await import('./telemetry.js');
  await initAiSdkTelemetry();
  
  // Ensure directories exist and clean stale IPC artifacts
  const isWin32 = process.platform === 'win32';
  if (isWin32) {
    ensureRuntimeDir();
    cleanupIpcArtifacts();
  } else {
    ensureSocketDir();
    cleanupSocket();
  }

  // Write PID file
  writePidFile();

  // Create state
  state = new DaemonState();

  // On Windows, local IPC is always loopback TCP (port may be ephemeral / 0).
  const localTcpHost = opts?.grpcHost ?? '127.0.0.1';
  const localTcpPort = isWin32 ? (opts?.grpcPort ?? 0) : opts?.grpcPort;

  // Register known listen ports before MCP init so self-connections are blocked
  state.mcpClientPool.setListenEndpoints({
    httpPorts: opts?.httpPort != null ? [opts.httpPort] : [],
    grpcPorts: localTcpPort != null && localTcpPort > 0 ? [localTcpPort] : [],
  });

  // Load proto and create server
  const proto = loadProto();
  const abbenayProto = (proto as unknown as { abbenay: { v1: { Abbenay: { service: grpc.ServiceDefinition } } } }).abbenay.v1;

  server = new grpc.Server();

  const allowOpenAuth = resolveAllowOpenAuth({
    allowOpenAuth: opts?.allowOpenAuth,
    insecure: opts?.grpcTls?.insecure,
  });
  // Windows local IPC is always loopback TCP; omit port when ephemeral so auth stays loopback-only.
  const authContext = buildConsumerAuthContext({
    grpcHost: isWin32 ? localTcpHost : opts?.grpcHost,
    grpcPort: isWin32
      ? (localTcpPort && localTcpPort > 0 ? localTcpPort : undefined)
      : opts?.grpcPort,
    allowOpenAuth,
  });

  // Add Abbenay service
  const abbenayService = createAbbenayService(state, authContext);
  server.addService(abbenayProto.Abbenay.service, abbenayService);

  const socketPath = getDefaultSocketPath();

  try {
    if (isWin32) {
      // Windows local IPC: bind loopback TCP (ephemeral port by default) and write daemon.addr.
      // Named-pipe gRPC is out of scope; reuse the existing TCP bind path.
      const boundPort = await bindTcpGrpc(
        server,
        localTcpHost,
        localTcpPort ?? 0,
        opts?.grpcTls ?? {},
        allowOpenAuth,
        authContext.loopbackOnly,
      );
      writeAddressFile(localTcpHost, boundPort);
      state.mcpClientPool.setListenEndpoints({
        httpPorts: opts?.httpPort != null ? [opts.httpPort] : [],
        grpcPorts: [boundPort],
      });
    } else {
      // Unix socket: local IPC only (filesystem permissions).
      // TLS is not used here — the TCP listener below is the network exposure path (C2).
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
        await bindTcpGrpc(
          server,
          grpcHost,
          opts.grpcPort,
          opts.grpcTls ?? {},
          allowOpenAuth,
          authContext.loopbackOnly,
        );
      }
    }
  } catch (err) {
    // Clean up PID file, IPC artifacts, and server on bind failure
    await new Promise<void>((resolve) => {
      server!.tryShutdown(() => resolve());
    });
    server = null;
    cleanupIpcArtifacts();
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
  
  cleanupIpcArtifacts();
  removePidFile();
  state = null;
}

/**
 * Stop external daemon
 */
export async function stopDaemon(): Promise<void> {
  const pid = readPidFile();

  if (!pid) {
    // No PID file, but maybe stale IPC artifacts exist
    cleanupIpcArtifacts();
    throw new Error('No daemon PID file found');
  }

  if (!isProcessRunning(pid)) {
    // Process not running, clean up
    removePidFile();
    cleanupIpcArtifacts();
    throw new Error('Daemon process not running (cleaned up stale files)');
  }

  // Kill the process
  const killed = killDaemon();

  if (killed) {
    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Clean up files if process didn't
    removePidFile();
    cleanupIpcArtifacts();
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
  address?: string;
} {
  const pid = readPidFile();

  if (process.platform === 'win32') {
    const addr = readAddressFile();
    const address = addr ? `${addr.host}:${addr.port}` : '';
    if (pid && isProcessRunning(pid)) {
      return { running: true, pid, socketPath: address, address };
    }
    return { running: false, pid: null, socketPath: address, address };
  }

  const socketPath = getDefaultSocketPath();

  if (pid && isProcessRunning(pid)) {
    return { running: true, pid, socketPath };
  }

  return { running: false, pid: null, socketPath };
}

/**
 * Bind gRPC on TCP and return the actual bound port.
 */
async function bindTcpGrpc(
  grpcServer: grpc.Server,
  grpcHost: string,
  grpcPort: number,
  tlsOpts: GrpcTlsOptions,
  allowOpenAuth: boolean,
  loopbackOnly: boolean,
): Promise<number> {
  const resolved = resolveTcpGrpcBind(grpcHost, tlsOpts);

  // DR-037: non-loopback binds require consumers (or explicit open auth)
  assertConsumersConfiguredForBind(grpcHost, loadConfig(), { allowOpenAuth });

  if (!resolved.tlsEnabled && tlsOpts.insecure) {
    console.warn(
      `[Daemon] WARNING: gRPC is bound to ${grpcHost} with --insecure (plaintext). ` +
      'API keys, chat, and provider config travel unencrypted. Prefer --grpc-tls.',
    );
  }
  // Only warn when open auth is actually active (empty consumers + escape hatch).
  // When consumers are configured, RPCs remain gated even with --allow-open-auth/--insecure.
  if (
    allowOpenAuth
    && !loopbackOnly
    && !hasConfiguredConsumers(loadConfig())
  ) {
    console.warn(
      `[Daemon] WARNING: gRPC on ${grpcHost} allows open consumer auth ` +
      '(--allow-open-auth / --insecure). Sensitive RPCs are not gated by consumers.',
    );
  } else if (resolved.tlsEnabled && (grpcHost === '0.0.0.0' || grpcHost === '::')) {
    console.warn(
      `[Daemon] gRPC TLS is enabled on ${grpcHost} — accessible from any network interface. ` +
      'Consumer authentication is required for sensitive RPCs.',
    );
  }

  return new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync(
      `${grpcHost}:${grpcPort}`,
      resolved.serverCredentials,
      (error, boundPort) => {
        if (error) {
          reject(error);
        } else {
          const mode = resolved.tlsEnabled ? 'TLS' : 'plaintext';
          console.log(`Abbenay gRPC listening on ${grpcHost}:${boundPort} (${mode})`);
          if (resolved.tlsEnabled && resolved.caPath) {
            console.log(
              `  TLS: auto-generated self-signed cert; clients should trust ${resolved.caPath}`,
            );
          }
          resolve(boundPort);
        }
      }
    );
  });
}
