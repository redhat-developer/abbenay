/**
 * Integration: MCP HTTP auth + connection consent + tool_policy (DR-033 / DR-034)
 *
 * Acceptance:
 * - Unauthenticated POST /mcp → 401
 * - tools/call without approved session → 403 (connection consent required)
 * - initialize blocks until POST /api/mcp/connections allow/deny
 * - disabled_tools / require_approval / auto_approve via authenticated session
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-mcp-policy-'));
const configPath = path.join(tmpConfigDir, 'config.yaml');

vi.mock('../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/paths.js')>();
  return {
    ...actual,
    getUserConfigPath: () => configPath,
    getConfigDir: () => tmpConfigDir,
  };
});

import { createWebApp } from '../../src/daemon/web/server.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { ToolRouter } from '../../src/daemon/tool-router.js';
import { AbbenayMcpServer } from '../../src/daemon/mcp-server.js';
import { SessionStore } from '../../src/core/session-store.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';
import * as yaml from 'js-yaml';

const TEST_TOKEN = 'test-mcp-policy-token';

const mockSecretStore: SecretStore = {
  async get() { return null; },
  async set() {},
  async delete() { return true; },
  async has() { return false; },
};

let sessionsDir: string;
let httpServer: http.Server;
let baseUrl: string;
let registry: ToolRegistry;
let mcpServer: AbbenayMcpServer;
let echoExecutor: ReturnType<typeof vi.fn>;
let dangerExecutor: ReturnType<typeof vi.fn>;
let clientSeq = 0;

function writePolicy(tool_policy: Record<string, unknown> | undefined): void {
  const cfg = tool_policy ? { tool_policy } : {};
  fs.writeFileSync(configPath, yaml.dump(cfg), 'utf-8');
}

function createState(): DaemonState {
  registry = new ToolRegistry();
  echoExecutor = vi.fn().mockResolvedValue({ echoed: true });
  dangerExecutor = vi.fn().mockResolvedValue({ danger: true });
  registry.register('agent', 'local', [
    {
      name: 'echo',
      description: 'Safe echo',
      inputSchema: JSON.stringify({ type: 'object', properties: { msg: { type: 'string' } } }),
      executor: echoExecutor,
    },
    {
      name: 'danger',
      description: 'Dangerous',
      inputSchema: JSON.stringify({ type: 'object', properties: {} }),
      executor: dangerExecutor,
    },
  ]);
  const router = new ToolRouter();
  mcpServer = new AbbenayMcpServer(registry, router);

  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore: mockSecretStore,
    sessionStore: new SessionStore(sessionsDir),
    toolRegistry: registry,
    mcpServer,
    async listProviders() { return []; },
    async listModels() { return []; },
    async discoverModels() { return []; },
    async resolveProviderCredentials() { return {}; },
    async chat() {
      return (async function* () {
        yield { type: 'done' as const, finishReason: 'stop' };
      })();
    },
    getStatus() {
      return { version: '0.1.0-test', uptime: 0, providers: 0, models: 0 };
    },
    getConnectedClients() { return []; },
    mcpClientPool: {
      getAllStatus() { return []; },
      async reconnect() {},
    },
  } as unknown as DaemonState;
}

function httpRequest(
  method: string,
  urlPath: string,
  opts?: {
    body?: unknown;
    headers?: Record<string, string>;
    token?: string | null;
  },
): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders; raw: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlPath, baseUrl);
    const headers: Record<string, string> = {
      Connection: 'close',
      Accept: 'application/json, text/event-stream',
      ...(opts?.headers || {}),
    };
    if (opts?.token !== null) {
      headers.Authorization = `Bearer ${opts?.token ?? TEST_TOKEN}`;
    }
    let bodyStr: string | undefined;
    if (opts?.body !== undefined) {
      bodyStr = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            // keep raw
          }
          resolve({ statusCode: res.statusCode || 0, body, headers: res.headers, raw });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function extractMcpResult(res: { body: any; raw: string }): any {
  if (res.body && typeof res.body === 'object' && (res.body.result || res.body.error)) {
    return res.body;
  }
  const lines = res.raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        /* continue */
      }
    }
  }
  return res.body;
}

async function waitForPendingConnection(timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await httpRequest('GET', '/api/mcp/connections');
    if (list.body.pending?.length > 0) {
      return list.body.pending[0].requestId as string;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for pending MCP connection consent');
}

/** Initialize + approve connection; returns Mcp-Session-Id. */
async function mcpConnect(clientName?: string, remember = false): Promise<string> {
  const name = clientName || `test-client-${++clientSeq}`;
  const initPromise = httpRequest('POST', '/mcp', {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name, version: '0.0.1' },
      },
    },
    headers: { 'MCP-Protocol-Version': '2024-11-05' },
  });

  const requestId = await waitForPendingConnection();
  const approve = await httpRequest('POST', `/api/mcp/connections/${requestId}`, {
    body: { decision: 'allow', remember },
  });
  expect(approve.statusCode).toBe(200);

  const res = await initPromise;
  expect(res.statusCode).toBe(200);
  const sessionId = res.headers['mcp-session-id'];
  expect(typeof sessionId).toBe('string');
  expect(sessionId!.length).toBeGreaterThan(0);
  return sessionId as string;
}

async function mcpJsonRpc(
  method: string,
  params: unknown | undefined,
  opts: { id?: number; sessionId?: string } = {},
): Promise<any> {
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': '2024-11-05',
  };
  if (opts.sessionId) {
    headers['Mcp-Session-Id'] = opts.sessionId;
  }
  const res = await httpRequest('POST', '/mcp', {
    body: {
      jsonrpc: '2.0',
      id: opts.id ?? 1,
      method,
      ...(params !== undefined ? { params } : {}),
    },
    headers,
  });
  return { http: res, rpc: extractMcpResult(res) };
}

beforeAll(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-mcp-sess-'));
  writePolicy({ auto_approve: ['local:agent/echo'] });

  const state = createState();
  const app = createWebApp(state, {
    apiToken: TEST_TOKEN,
    skipConfig: false,
    host: '127.0.0.1',
  });

  await mcpServer.start(app);

  const port = await new Promise<number>((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await mcpServer.stop();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

beforeEach(() => {
  echoExecutor.mockClear();
  dangerExecutor.mockClear();
  writePolicy({ auto_approve: ['local:agent/echo'] });
});

describe('MCP HTTP authentication', () => {
  it('rejects unauthenticated POST /mcp', async () => {
    const res = await httpRequest('POST', '/mcp', {
      token: null,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated GET /mcp', async () => {
    const res = await httpRequest('GET', '/mcp', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated DELETE /mcp', async () => {
    const res = await httpRequest('DELETE', '/mcp', { token: null });
    expect(res.statusCode).toBe(401);
  });
});

describe('MCP connection consent (DR-034)', () => {
  it('rejects tools/call without an approved session', async () => {
    const call = await mcpJsonRpc('tools/call', { name: 'echo', arguments: {} }, { id: 99 });
    expect(call.http.statusCode).toBe(403);
    expect(String(call.http.body?.error || '')).toMatch(/consent/i);
    expect(echoExecutor).not.toHaveBeenCalled();
  });

  it('initialize blocks until connection is approved', async () => {
    const initPromise = httpRequest('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'consent-block-client', version: '1.0.0' },
        },
      },
      headers: { 'MCP-Protocol-Version': '2024-11-05' },
    });

    const requestId = await waitForPendingConnection();
    const list = await httpRequest('GET', '/api/mcp/connections');
    expect(list.body.pending.some((p: { clientName: string }) => p.clientName === 'consent-block-client')).toBe(true);

    await httpRequest('POST', `/api/mcp/connections/${requestId}`, {
      body: { decision: 'allow' },
    });

    const res = await initPromise;
    expect(res.statusCode).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();
  });

  it('denied connection returns 403 and creates no session', async () => {
    const initPromise = httpRequest('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'denied-client', version: '1.0.0' },
        },
      },
      headers: { 'MCP-Protocol-Version': '2024-11-05' },
    });

    const requestId = await waitForPendingConnection();
    await httpRequest('POST', `/api/mcp/connections/${requestId}`, {
      body: { decision: 'deny' },
    });

    const res = await initPromise;
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/denied/i);
    expect(mcpServer.listSessions().some((s) => s.clientName === 'denied-client')).toBe(false);
  });

  it('Allow & Remember skips consent on reconnect', async () => {
    const name = `remembered-${++clientSeq}`;
    const session1 = await mcpConnect(name, true);
    expect(session1).toBeTruthy();

    // Second initialize should not create a pending connection
    const res = await httpRequest('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name, version: '0.0.2' },
        },
      },
      headers: { 'MCP-Protocol-Version': '2024-11-05' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();

    const list = await httpRequest('GET', '/api/mcp/connections');
    expect(list.body.pending.some((p: { clientName: string }) => p.clientName === name)).toBe(false);
    expect(list.body.remembered).toContain(name);
  });

  it('does not remember unknown-client placeholder', async () => {
    const sessionId = await mcpConnect('unknown-client', true);
    expect(sessionId).toBeTruthy();

    const list = await httpRequest('GET', '/api/mcp/connections');
    expect(list.body.remembered).not.toContain('unknown-client');

    // Next initialize with the same placeholder still requires consent
    const initPromise = httpRequest('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'unknown-client', version: '0.0.3' },
        },
      },
      headers: { 'MCP-Protocol-Version': '2024-11-05' },
    });
    const requestId = await waitForPendingConnection();
    await httpRequest('POST', `/api/mcp/connections/${requestId}`, {
      body: { decision: 'allow' },
    });
    const res = await initPromise;
    expect(res.statusCode).toBe(200);
  });

  it('DELETE remembered client requires consent again', async () => {
    const name = `forget-me-${++clientSeq}`;
    await mcpConnect(name, true);

    let list = await httpRequest('GET', '/api/mcp/connections');
    expect(list.body.remembered).toContain(name);

    const forgotten = await httpRequest(
      'DELETE',
      `/api/mcp/connections/remembered/${encodeURIComponent(name)}`,
    );
    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.body.forgotten).toBe(name);

    list = await httpRequest('GET', '/api/mcp/connections');
    expect(list.body.remembered).not.toContain(name);

    // Next initialize needs consent again
    const initPromise = httpRequest('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name, version: '0.0.4' },
        },
      },
      headers: { 'MCP-Protocol-Version': '2024-11-05' },
    });
    const requestId = await waitForPendingConnection();
    expect(requestId).toBeTruthy();
    await httpRequest('POST', `/api/mcp/connections/${requestId}`, {
      body: { decision: 'deny' },
    });
    const res = await initPromise;
    expect(res.statusCode).toBe(403);
  });
});

describe('MCP HTTP tool_policy', () => {
  it('rejects disabled_tools via authenticated authorizeAndExecute (same path as /mcp handlers)', async () => {
    writePolicy({ disabled_tools: ['local:agent/danger'] });
    const tool = registry.resolve('danger')!;
    const result = await mcpServer.authorizeAndExecute(tool, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
    expect(dangerExecutor).not.toHaveBeenCalled();
  });

  it('auto_approve runs only when policy allows', async () => {
    writePolicy({ auto_approve: ['local:agent/echo'] });
    const echo = registry.resolve('echo')!;
    const ok = await mcpServer.authorizeAndExecute(echo, { msg: 'hi' });
    expect(ok.isError).toBeUndefined();
    expect(echoExecutor).toHaveBeenCalled();

    echoExecutor.mockClear();
    const danger = registry.resolve('danger')!;
    const execPromise = mcpServer.authorizeAndExecute(danger, {});
    let requestId: string | undefined;
    for (let i = 0; i < 20; i++) {
      const list = await httpRequest('GET', '/api/mcp/approvals');
      if (list.body.pending?.length > 0) {
        requestId = list.body.pending[0].requestId;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestId).toBeDefined();
    expect(dangerExecutor).not.toHaveBeenCalled();

    await httpRequest('POST', `/api/mcp/approvals/${requestId}`, {
      body: { decision: 'deny' },
    });
    const denied = await execPromise;
    expect(denied.isError).toBe(true);
    expect(dangerExecutor).not.toHaveBeenCalled();
  });

  it('require_approval blocks until approve API allows execution', async () => {
    writePolicy({
      auto_approve: ['local:agent/*'],
      require_approval: ['local:agent/danger'],
    });

    const danger = registry.resolve('danger')!;
    const execPromise = mcpServer.authorizeAndExecute(danger, { force: true });

    let requestId: string | undefined;
    for (let i = 0; i < 20; i++) {
      const list = await httpRequest('GET', '/api/mcp/approvals');
      if (list.body.pending?.length > 0) {
        requestId = list.body.pending[0].requestId;
        expect(list.body.pending[0].namespacedName).toBe('local:agent/danger');
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestId).toBeDefined();
    expect(dangerExecutor).not.toHaveBeenCalled();

    const approve = await httpRequest('POST', `/api/mcp/approvals/${requestId}`, {
      body: { decision: 'allow' },
    });
    expect(approve.statusCode).toBe(200);

    const result = await execPromise;
    expect(result.isError).toBeUndefined();
    expect(dangerExecutor).toHaveBeenCalledWith({ force: true });
  });

  it('E2E: authenticated tools/call honors disabled_tools (after connection consent)', async () => {
    writePolicy({
      disabled_tools: ['local:agent/danger'],
      auto_approve: ['local:agent/echo'],
    });

    const sessionId = await mcpConnect();
    const call = await mcpJsonRpc('tools/call', {
      name: 'danger',
      arguments: {},
    }, { id: 42, sessionId });

    expect(call.http.statusCode).toBe(200);
    const rpc = call.rpc;
    if (rpc?.result) {
      expect(rpc.result.isError).toBe(true);
      expect(String(rpc.result.content?.[0]?.text || '')).toMatch(/disabled|not found|denied/i);
    } else {
      expect(String(rpc?.error?.message || '')).toMatch(/disabled|not found|denied/i);
    }
    expect(dangerExecutor).not.toHaveBeenCalled();
  });

  it('E2E: authenticated tools/call auto_approve executes (after connection consent)', async () => {
    writePolicy({ auto_approve: ['local:agent/echo'] });

    const sessionId = await mcpConnect();
    const call = await mcpJsonRpc('tools/call', {
      name: 'echo',
      arguments: { msg: 'via-mcp' },
    }, { id: 43, sessionId });

    expect(call.http.statusCode).toBe(200);
    expect(call.rpc?.result?.isError).not.toBe(true);
    expect(echoExecutor).toHaveBeenCalled();
    expect(String(call.rpc?.result?.content?.[0]?.text || '')).toContain('echoed');
  });

  it('E2E: require_approval via POST /mcp blocks until approve API', async () => {
    writePolicy({
      auto_approve: ['local:agent/echo'],
      require_approval: ['local:agent/danger'],
    });

    const sessionId = await mcpConnect();
    const callPromise = mcpJsonRpc('tools/call', {
      name: 'danger',
      arguments: {},
    }, { id: 44, sessionId });

    let requestId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const list = await httpRequest('GET', '/api/mcp/approvals');
      if (list.body.pending?.length > 0) {
        requestId = list.body.pending[0].requestId;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(requestId).toBeDefined();
    expect(dangerExecutor).not.toHaveBeenCalled();

    await httpRequest('POST', `/api/mcp/approvals/${requestId}`, {
      body: { decision: 'allow' },
    });

    const call = await callPromise;
    expect(call.http.statusCode).toBe(200);
    expect(call.rpc?.result?.isError).not.toBe(true);
    expect(dangerExecutor).toHaveBeenCalled();
  });
});

describe('MCP pending consent / approval TTL', () => {
  let ttlHttpServer: http.Server;
  let ttlBaseUrl: string;
  let ttlMcpServer: AbbenayMcpServer;
  let ttlRegistry: ToolRegistry;
  let ttlSessionsDir: string;

  function ttlRequest(
    method: string,
    urlPath: string,
    opts?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<{ statusCode: number; body: any }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(urlPath, ttlBaseUrl);
      const headers: Record<string, string> = {
        Connection: 'close',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        ...(opts?.headers || {}),
      };
      let bodyStr: string | undefined;
      if (opts?.body !== undefined) {
        bodyStr = JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      }
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            let body: any = raw;
            try { body = JSON.parse(raw); } catch { /* keep raw */ }
            resolve({ statusCode: res.statusCode || 0, body });
          });
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  beforeAll(async () => {
    ttlSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-mcp-ttl-'));
    writePolicy({ auto_approve: ['local:agent/echo'] });

    ttlRegistry = new ToolRegistry();
    ttlRegistry.register('agent', 'local', [
      {
        name: 'echo',
        description: 'Safe echo',
        inputSchema: JSON.stringify({ type: 'object', properties: {} }),
        executor: async () => ({ ok: true }),
      },
    ]);
    const router = new ToolRouter();
    ttlMcpServer = new AbbenayMcpServer(ttlRegistry, router);

    const state = {
      version: '0.1.0-test',
      startedAt: new Date(),
      secretStore: mockSecretStore,
      sessionStore: new SessionStore(ttlSessionsDir),
      toolRegistry: ttlRegistry,
      mcpServer: ttlMcpServer,
      async listProviders() { return []; },
      async listModels() { return []; },
      async discoverModels() { return []; },
      async resolveProviderCredentials() { return {}; },
      async chat() {
        return (async function* () {
          yield { type: 'done' as const, finishReason: 'stop' };
        })();
      },
      getStatus() {
        return { version: '0.1.0-test', uptime: 0, providers: 0, models: 0 };
      },
      getConnectedClients() { return []; },
      mcpClientPool: {
        getAllStatus() { return []; },
        async reconnect() {},
      },
    } as unknown as DaemonState;

    const app = createWebApp(state, {
      apiToken: TEST_TOKEN,
      skipConfig: false,
      host: '127.0.0.1',
      mcpPendingTtlMs: 80,
    });
    await ttlMcpServer.start(app);

    const port = await new Promise<number>((resolve) => {
      ttlHttpServer = app.listen(0, '127.0.0.1', () => {
        const addr = ttlHttpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    ttlBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await ttlMcpServer.stop();
    if (ttlHttpServer) {
      await new Promise<void>((resolve) => ttlHttpServer.close(() => resolve()));
    }
    fs.rmSync(ttlSessionsDir, { recursive: true, force: true });
  });

  it('auto-denies abandoned initialize after TTL and clears pending map', async () => {
    const initPromise = ttlRequest('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ttl-client', version: '0.0.1' },
        },
      },
      headers: { 'MCP-Protocol-Version': '2024-11-05' },
    });

    let sawPending = false;
    for (let i = 0; i < 40; i++) {
      const list = await ttlRequest('GET', '/api/mcp/connections');
      if (list.body.pending?.length > 0) {
        sawPending = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sawPending).toBe(true);

    const res = await initPromise;
    expect(res.statusCode).toBe(403);
    expect(String(res.body.error || '')).toMatch(/denied/i);

    const list = await ttlRequest('GET', '/api/mcp/connections');
    expect(list.body.pending).toEqual([]);
  });

  it('auto-denies abandoned tool approval after TTL', async () => {
    writePolicy({}); // default ask → approval required

    const echo = ttlRegistry.resolve('echo')!;
    const resultPromise = ttlMcpServer.authorizeAndExecute(echo, {});

    let approvalId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const list = await ttlRequest('GET', '/api/mcp/approvals');
      if (list.body.pending?.length > 0) {
        approvalId = list.body.pending[0].requestId;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(approvalId).toBeDefined();

    const denied = await resultPromise;
    expect(denied.isError).toBe(true);

    const list = await ttlRequest('GET', '/api/mcp/approvals');
    expect(list.body.pending).toEqual([]);
  });
});
