/**
 * Integration E2E: stdio MCP spawn policy (DR-043 / finding H6)
 *
 * Acceptance:
 * - Non-allowlisted command (e.g. /bin/sh) → rejected, no process spawned
 * - Allowlisted command + operator approval → process starts
 * - Unauthenticated / unauthorized when consumers enabled → registration denied
 * - Denial reason is clear in gRPC error + recent denials API
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, '../../../../proto/abbenay/v1/service.proto');
const PROTO_INCLUDE = path.resolve(__dirname, '../../../../proto');

const TOKEN_ENV = 'ABBENAY_TEST_STDIO_MCP_TOKEN';
const GOOD_TOKEN = 'stdio-mcp-token';
const CHAT_ONLY_TOKEN = 'chat-only-token';

const stdioTransportConstructs: unknown[] = [];

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn().mockImplementation(async () => ({
    tools: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: 'ping', description: 'ping', inputSchema: {} }],
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: class {
    constructor(public opts: unknown) {
      stdioTransportConstructs.push(opts);
    }
  },
}));

const mockLoadConfig = vi.fn();
vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return {
    ...actual,
    loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
    loadWorkspaceConfig: () => null,
    saveConfig: vi.fn(),
    saveWorkspaceConfig: vi.fn(),
    getUserConfigPath: () => '/tmp/abbenay-stdio-mcp-test-config.yaml',
    getWorkspaceConfigPath: () => '/tmp/abbenay-stdio-mcp-test-ws.yaml',
  };
});

vi.mock('../../src/core/engines.js', () => ({
  getEngines: () => [
    { id: 'mock', requiresKey: false, supportsTools: false, createModel: () => { throw new Error('mock'); } },
  ],
  getEngine: (id: string) => (id === 'mock' ? { id: 'mock', requiresKey: false } : undefined),
  fetchModels: async () => [],
  streamChat: async function* () { yield { type: 'done', finishReason: 'stop' }; },
  getProviderTemplates: () => [],
}));

vi.mock('../../src/daemon/secrets/keychain.js', () => ({
  KeychainSecretStore: class {
    async get() { return null; }
    async set() {}
    async delete() { return true; }
    async has() { return false; }
  },
}));

let mockSessionsDir: string;
vi.mock('../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/paths.js')>();
  return {
    ...actual,
    getSessionsDir: () => mockSessionsDir,
  };
});

import { DaemonState } from '../../src/daemon/state.js';
import { createAbbenayService } from '../../src/daemon/server/abbenay-service.js';
import { createWebApp } from '../../src/daemon/web/server.js';
import { createMCPClient } from '@ai-sdk/mcp';

function loadProto() {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_INCLUDE],
  });
  return grpc.loadPackageDefinition(packageDef);
}

function meta(token?: string): grpc.Metadata {
  const m = new grpc.Metadata();
  if (token) m.add('x-abbenay-token', token);
  return m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callUnary(client: any, method: string, request: object, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, meta(token), (error: grpc.ServiceError | null, response: unknown) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function httpRequest(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      reject(new Error('no address'));
      return;
    }
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          Authorization: 'Bearer test-http-token',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('MCP stdio spawn policy E2E (H6)', () => {
  let server: grpc.Server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let state: DaemonState;
  let httpServer: http.Server | undefined;

  beforeAll(async () => {
    process.env[TOKEN_ENV] = GOOD_TOKEN;
    process.env.ABBENAY_TEST_CHAT_ONLY = CHAT_ONLY_TOKEN;
    mockSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-stdio-mcp-'));

    mockLoadConfig.mockReturnValue({
      providers: {},
      security: {
        stdio_command_allowlist: ['npx'],
        stdio_require_approval: true,
      },
      consumers: {
        apme: {
          token_env: TOKEN_ENV,
          capabilities: { mcp_register: true },
        },
        chatter: {
          token_env: 'ABBENAY_TEST_CHAT_ONLY',
          capabilities: { chat: true },
        },
      },
      server: { api_token: 'test-http-token' },
    });

    state = new DaemonState();
    state.mcpClientPool.applySecurityConfig({
      stdio_command_allowlist: ['npx'],
      stdio_require_approval: true,
    });

    const proto = loadProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const abbenayProto = (proto as any).abbenay.v1;

    server = new grpc.Server();
    server.addService(abbenayProto.Abbenay.service, createAbbenayService(state));

    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
        if (err) reject(err);
        else resolve(p);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client = new (abbenayProto as any).Abbenay(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(new Date(Date.now() + 5000), (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Web app wires stdio spawn approval handler + API
    const app = createWebApp(state, {
      apiToken: 'test-http-token',
      skipConfig: true,
      host: '127.0.0.1',
    });
    httpServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterAll(async () => {
    client?.close();
    await new Promise<void>((resolve) => server?.tryShutdown(() => resolve()));
    await new Promise<void>((resolve) => {
      if (!httpServer) { resolve(); return; }
      httpServer.close(() => resolve());
    });
    state.mcpClientPool.stopHealthCheck();
    await state.mcpClientPool.disconnectAll();
    fs.rmSync(mockSessionsDir, { recursive: true, force: true });
    delete process.env[TOKEN_ENV];
    delete process.env.ABBENAY_TEST_CHAT_ONLY;
  });

  beforeEach(() => {
    stdioTransportConstructs.length = 0;
    vi.mocked(createMCPClient).mockClear();
  });

  afterEach(async () => {
    for (const s of state.mcpClientPool.getStatuses()) {
      if (s.source === 'dynamic') {
        await state.mcpClientPool.disconnect(s.id);
      }
    }
  });

  it('rejects non-allowlisted /bin/sh and does not spawn', async () => {
    try {
      await callUnary(client, 'RegisterMcpServer', {
        server_id: 'evil-sh',
        transport: {
          type: 'stdio',
          command: '/bin/sh',
          args: ['-c', 'id'],
        },
      }, GOOD_TOKEN);
      expect.fail('expected PERMISSION_DENIED');
    } catch (err) {
      const e = err as grpc.ServiceError;
      expect(e.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(e.message).toMatch(/not in security\.stdio_command_allowlist|DENIED|denied/i);
      expect(e.details || e.message).toMatch(/\/bin\/sh/);
    }

    expect(stdioTransportConstructs).toHaveLength(0);
    expect(vi.mocked(createMCPClient)).not.toHaveBeenCalled();

    const list = await httpRequest(httpServer!, 'GET', '/api/mcp/stdio-spawns');
    expect(list.statusCode).toBe(200);
    expect(list.body.denials.some((d: { reason: string }) => d.reason.includes('/bin/sh'))).toBe(true);
  });

  it('registers allowlisted npx after operator approval via API', async () => {
    const registerPromise = callUnary(client, 'RegisterMcpServer', {
      server_id: 'trusted-npx',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
    }, GOOD_TOKEN);

    // Wait for pending approval to appear
    let requestId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const list = await httpRequest(httpServer!, 'GET', '/api/mcp/stdio-spawns');
      if (list.body.pending?.length > 0) {
        requestId = list.body.pending[0].requestId;
        expect(list.body.pending[0].command).toBe('npx');
        expect(list.body.pending[0].serverId).toBe('trusted-npx');
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestId).toBeDefined();
    // Still no spawn while pending
    expect(stdioTransportConstructs).toHaveLength(0);

    const approve = await httpRequest(httpServer!, 'POST', `/api/mcp/stdio-spawns/${requestId}`, {
      decision: 'allow',
    });
    expect(approve.statusCode).toBe(200);

    const result = await registerPromise;
    expect(result.success).toBe(true);
    expect(result.discovered_tools?.length).toBeGreaterThanOrEqual(1);
    expect(stdioTransportConstructs).toHaveLength(1);
    expect(state.mcpClientPool.getStatus('trusted-npx')?.connected).toBe(true);
  });

  it('denies registration without auth when consumers are configured', async () => {
    try {
      await callUnary(client, 'RegisterMcpServer', {
        server_id: 'no-auth',
        transport: { type: 'stdio', command: 'npx', args: [] },
      });
      expect.fail('expected PERMISSION_DENIED');
    } catch (err) {
      const e = err as grpc.ServiceError;
      expect(e.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(e.message).toMatch(/consumer authentication|Permission denied|mcp_register/i);
    }
    expect(stdioTransportConstructs).toHaveLength(0);
  });

  it('denies registration without mcp_register capability', async () => {
    try {
      await callUnary(client, 'RegisterMcpServer', {
        server_id: 'chat-only',
        transport: { type: 'stdio', command: 'npx', args: [] },
      }, CHAT_ONLY_TOKEN);
      expect.fail('expected PERMISSION_DENIED');
    } catch (err) {
      const e = err as grpc.ServiceError;
      expect(e.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(e.message).toMatch(/MCP registration|capability|lacks/i);
    }
    expect(stdioTransportConstructs).toHaveLength(0);
  });
});
