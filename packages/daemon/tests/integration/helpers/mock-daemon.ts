/**
 * Mock gRPC daemon server for testing.
 * 
 * Implements the Abbenay gRPC service with predictable, deterministic responses.
 * Uses TCP (127.0.0.1:0) so tests don't need Unix socket permissions.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Proto path relative to this test helper
const PROTO_PATH = path.resolve(__dirname, '../../../../../proto/abbenay/v1/service.proto');
const PROTO_INCLUDE = path.resolve(__dirname, '../../../../../proto');

/**
 * Options for the mock Chat handler
 */
export interface MockChatOptions {
  /** Text chunks to stream (default: ['Hello', ' world', '!']) */
  chunks?: string[];
  /** Delay between chunks in ms (default: 10) */
  chunkDelayMs?: number;
  /** Finish reason (default: 'stop') */
  finishReason?: string;
  /** If set, return an error instead of streaming */
  errorMessage?: string;
  /** If set, delay this long before first chunk (simulates processing) */
  initialDelayMs?: number;
}

/**
 * A running mock daemon with its gRPC address
 */
export interface MockDaemon {
  /** gRPC address (e.g. "127.0.0.1:50123") */
  address: string;
  /** The gRPC server instance */
  server: grpc.Server;
  /** Port the server is listening on */
  port: number;
  /** Stop the mock daemon */
  stop: () => Promise<void>;
  /** Update mock Chat behavior at runtime */
  setChatOptions: (opts: MockChatOptions) => void;
  /** Record of received Chat requests */
  chatRequests: Array<{ model: string; messages: any[] }>;
  /** Record of received Register requests */
  registerRequests: any[];
}

/**
 * Create and start a mock daemon gRPC server.
 * Binds to a random TCP port on localhost.
 */
export async function createMockDaemon(chatOptions?: MockChatOptions): Promise<MockDaemon> {
  let currentChatOptions: MockChatOptions = chatOptions || {};
  const chatRequests: Array<{ model: string; messages: any[] }> = [];
  const registerRequests: any[] = [];
  
  // Load proto
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_INCLUDE],
  });
  const proto = grpc.loadPackageDefinition(packageDef);
  const abbenayProto = (proto as any).abbenay.v1;
  
  const server = new grpc.Server();
  
  // ─── Service implementation ───────────────────────────────────────────
  
  server.addService(abbenayProto.Abbenay.service, {
    /**
     * Register - return a mock client ID
     */
    Register(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      registerRequests.push(call.request);
      callback(null, {
        client_id: 'mock-client-001',
        connected_clients: 1,
      });
    },
    
    Unregister(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {});
    },
    
    /**
     * Chat - Stream text chunks with configurable behavior
     */
    Chat(call: grpc.ServerWritableStream<any, any>) {
      const request = call.request;
      chatRequests.push({
        model: request.model,
        messages: request.messages || [],
      });
      
      const opts = currentChatOptions;
      const chunks = opts.chunks || ['Hello', ' world', '!'];
      const delayMs = opts.chunkDelayMs ?? 10;
      const finishReason = opts.finishReason || 'stop';
      const initialDelay = opts.initialDelayMs ?? 0;
      
      if (opts.errorMessage) {
        call.write({ error: { code: 'INTERNAL', message: opts.errorMessage } });
        call.end();
        return;
      }
      
      // Stream chunks asynchronously
      (async () => {
        try {
          if (initialDelay > 0) {
            await sleep(initialDelay);
          }
          
          for (const text of chunks) {
            // Check if stream was cancelled
            if (call.cancelled) {
              return;
            }
            call.write({ text: { text } });
            if (delayMs > 0) {
              await sleep(delayMs);
            }
          }
          
          if (!call.cancelled) {
            call.write({ done: { finish_reason: finishReason } });
            call.end();
          }
        } catch (_err: unknown) {
          if (!call.cancelled) {
            try { call.end(); } catch { /* stream already closed */ }
          }
        }
      })();
    },
    
    /**
     * HealthCheck
     */
    HealthCheck(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {
        healthy: true,
        version: '0.1.0-mock',
      });
    },
    
    /**
     * GetStatus
     */
    GetStatus(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {
        version: '0.1.0-mock',
        started_at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
        connected_clients: 1,
        active_sessions: 0,
        clients: [],
      });
    },
    
    /**
     * ListProviders
     */
    ListProviders(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {
        providers: [
          { id: 'openai', configured: true, healthy: true },
          { id: 'anthropic', configured: false, healthy: true },
        ],
      });
    },
    
    /**
     * ListModels
     */
    ListModels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {
        models: [
          { id: 'openai/gpt-4o', provider: 'openai' },
          { id: 'openai/gpt-4o-mini', provider: 'openai' },
        ],
      });
    },
    
    /**
     * GetConnectedWorkspaces
     */
    GetConnectedWorkspaces(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { workspaces: ['/home/test/project'] });
    },
    
    /**
     * Secrets - in-memory store for testing
     */
    GetSecret(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { value: 'mock-secret-value', found: true });
    },
    SetSecret(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {});
    },
    DeleteSecret(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {});
    },
    ListSecrets(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {
        secrets: [
          { key: 'OPENAI_API_KEY', has_value: true },
          { key: 'ANTHROPIC_API_KEY', has_value: false },
        ],
      });
    },
    
    /**
     * Config
     */
    GetConfig(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { default_model: '', providers: {}, session_ttl_days: 0, log_level: 3 });
    },
    UpdateConfig(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { default_model: '', providers: {}, session_ttl_days: 0, log_level: 3 });
    },
    
    GetProviderStatus(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { provider_id: call.request.provider_id, configured: true, healthy: true });
    },
    
    Shutdown(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {});
    },
    
    // ─── Stub RPCs ──────────────────────────────────────────────────────
    
    SessionChat(call: grpc.ServerWritableStream<any, any>) {
      call.write({ error: { code: 'UNIMPLEMENTED', message: 'Not implemented in mock' } });
      call.end();
    },
    CreateSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    GetSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    ListSessions(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { sessions: [], total_count: 0 });
    },
    DeleteSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    WatchSessions(call: grpc.ServerWritableStream<any, any>) { call.end(); },
    ReplaySession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    SummarizeSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    ForkSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    ExportSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    ImportSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    ListTools(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, { tools: [] });
    },
    ExecuteTool(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
    },
    RegisterMcpServer(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {});
    },
    UnregisterMcpServer(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {});
    },
    VSCodeStream(call: grpc.ServerDuplexStream<any, any>) {
      call.on('end', () => call.end());
    },
  });
  
  // ─── Bind to random TCP port ──────────────────────────────────────────
  
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (error, port) => {
        if (error) reject(error);
        else resolve(port);
      }
    );
  });
  
  const address = `127.0.0.1:${boundPort}`;
  
  return {
    address,
    server,
    port: boundPort,
    stop: () => new Promise<void>((resolve) => {
      server.tryShutdown(() => resolve());
    }),
    setChatOptions: (opts: MockChatOptions) => {
      currentChatOptions = opts;
    },
    chatRequests,
    registerRequests,
  };
}

/**
 * Create a gRPC client connected to the given address (for testing)
 */
export function createTestClient(address: string): any {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_INCLUDE],
  });
  const proto = grpc.loadPackageDefinition(packageDef);
  return new (proto as any).abbenay.v1.Abbenay(
    address,
    grpc.credentials.createInsecure(),
  );
}

/**
 * Helper: call a unary RPC and return the result as a promise
 */
export function callUnary(client: any, method: string, request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, (error: any, response: any) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
