/**
 * Unit tests for embedded web server lifecycle and createWebApp routes.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWebApp,
  startEmbeddedWebServer,
  stopEmbeddedWebServer,
  isWebServerRunning,
  getWebServerPort,
} from './server.js';
import type { DaemonState } from '../state.js';
import type { ConnectedClient } from '../state.js';
import type { ProviderInfo, ModelInfo, ChatToolOptions } from '../../core/state.js';
import type { SecretStore } from '../../core/secrets.js';
import { SessionStore } from '../../core/session-store.js';
import { API_TOKEN_COOKIE, CSRF_COOKIE } from './http-security.js';

const TEST_TOKEN = 'unit-test-web-api-token';

const hoisted = vi.hoisted(() => ({
  configOverrides: { userConfigPath: null as string | null },
  tmpConfigDir: undefined as string | undefined,
}));

vi.mock('../../core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/paths.js')>();
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');

  const ensureConfigDir = () => {
    if (!hoisted.tmpConfigDir) {
      hoisted.tmpConfigDir = nodeFs.mkdtempSync(
        nodePath.join(nodeOs.tmpdir(), 'abbenay-server-unit-config-'),
      );
    }
    return hoisted.tmpConfigDir;
  };

  return {
    ...actual,
    getUserConfigPath: () => hoisted.configOverrides.userConfigPath ?? nodePath.join(ensureConfigDir(), 'config.yaml'),
    getWorkspaceConfigPath: (wsPath: string) => nodePath.join(wsPath, '.config', 'abbenay', 'config.yaml'),
    getConfigDir: () => ensureConfigDir(),
  };
});

afterAll(() => {
  if (hoisted.tmpConfigDir) {
    fs.rmSync(hoisted.tmpConfigDir, { recursive: true, force: true });
  }
});

function getEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null || !addr.port) {
        server.close(() => reject(new Error(`Failed to allocate ephemeral port on ${host}`)));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function createSecretStore(overrides?: Partial<SecretStore>): SecretStore {
  return {
    async get() { return null; },
    async set() {},
    async delete() { return true; },
    async has() { return false; },
    ...overrides,
  };
}

interface MockStateOptions {
  sessionsDir: string;
  secretStore?: SecretStore;
  providers?: ProviderInfo[];
  models?: ModelInfo[];
  discoverModels?: ModelInfo[];
  resolveCredentials?: { apiKey?: string; baseUrl?: string };
  chatChunks?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool'; name: string; state: string; done: boolean; call?: { params: unknown; result: unknown } }
    | { type: 'error'; error: string }
    | { type: 'done'; finishReason: string }
  >;
  onToolApprovalNeeded?: (requestId: string, toolName: string, args: unknown) => void;
  clients?: ConnectedClient[];
  vscodeWorkspaces?: string[];
  vscodeConnectionIds?: string[];
  requestWorkspaceFails?: boolean;
  mcpRunning?: boolean;
  mcpSessions?: Array<{ sessionId: string; clientName: string }>;
  rememberedClients?: string[];
  toolRegistryTools?: Array<{
    namespacedName: string;
    originalName: string;
    source: string;
    sourceType: string;
    description: string;
  }>;
  mcpPoolStatuses?: Array<{
    id: string;
    connected: boolean;
    error?: string;
    toolCount?: number;
    config?: { transport?: string; enabled?: boolean };
  }>;
  throwOnListProviders?: boolean;
}

function createMockState(opts: MockStateOptions): DaemonState {
  const {
    sessionsDir,
    secretStore = createSecretStore(),
    providers = [],
    models = [],
    discoverModels = [],
    resolveCredentials = {},
    chatChunks = [{ type: 'done', finishReason: 'stop' }],
    onToolApprovalNeeded,
    clients = [],
    vscodeWorkspaces = [],
    vscodeConnectionIds = [],
    requestWorkspaceFails = false,
    mcpRunning = false,
    mcpSessions = [],
    rememberedClients = [],
    toolRegistryTools = [],
    mcpPoolStatuses = [],
    throwOnListProviders = false,
  } = opts;

  let running = mcpRunning;

  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore,
    sessionStore: new SessionStore(sessionsDir),
    clientCount: clients.length,
    getClients() { return clients; },
    getConnectedClients() { return clients; },
    getVSCodeWorkspaces() { return vscodeWorkspaces; },
    getVSCodeConnectionIds() { return vscodeConnectionIds; },
    async requestWorkspace() {
      if (requestWorkspaceFails) throw new Error('timeout');
    },
    notifyModelsChanged() {},
    async refreshMcpConnections() {},
    async listProviders() {
      if (throwOnListProviders) throw new Error('provider list failed');
      return providers;
    },
    async listModels() { return models; },
    async discoverModels() { return discoverModels; },
    async resolveProviderCredentials() { return resolveCredentials; },
    async *chat(
      _model: string,
      _messages: Array<{ role: string; content: string }>,
      _params?: Record<string, unknown>,
      toolOptions?: ChatToolOptions,
    ) {
      if (onToolApprovalNeeded && toolOptions?.onToolApprovalNeeded) {
        const decision = await toolOptions.onToolApprovalNeeded('req-1', 'my_tool', { x: 1 });
        if (decision === 'abort') {
          yield { type: 'done' as const, finishReason: 'stop' };
          return;
        }
      }
      for (const chunk of chatChunks) {
        yield chunk;
      }
    },
    getStatus() {
      return { version: '0.1.0-test', uptime: 0, providers: 0, models: 0 };
    },
    mcpClientPool: {
      getAllStatus() { return mcpPoolStatuses; },
      getStatuses() { return mcpPoolStatuses; },
      getRecentDenials() { return [{ serverId: 'srv', command: 'echo', at: Date.now() }]; },
      applySecurityConfig() {},
      setStdioSpawnApprovalHandler() {},
      setListenEndpoints() {},
      async reconnect() {},
    },
    toolRegistry: {
      listTools() { return []; },
      getAll() { return toolRegistryTools; },
      get size() { return toolRegistryTools.length; },
    },
    mcpServer: {
      get isRunning() { return running; },
      getStatus() { return { running, transport: 'stdio' as const }; },
      configure() {},
      listSessions() { return mcpSessions; },
      listRememberedClients() { return [...rememberedClients]; },
      rememberClient(name: string) { rememberedClients.push(name); },
      forgetClient(name: string) {
        const idx = rememberedClients.indexOf(name);
        if (idx >= 0) rememberedClients.splice(idx, 1);
      },
      async revokeSession(id: string) { return mcpSessions.some((s) => s.sessionId === id); },
      async start() { running = true; },
      async stop() { running = false; },
    },
  } as unknown as DaemonState;
}

type HttpResult = {
  statusCode: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  raw: string;
};

function httpRequest(
  baseUrl: string,
  method: string,
  urlPath: string,
  opts?: {
    token?: string | null;
    headers?: Record<string, string>;
    body?: unknown;
    form?: Record<string, string>;
    cookie?: string;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
    if (opts?.cookie) headers.cookie = opts.cookie;
    if (opts?.token !== null) {
      headers.authorization = `Bearer ${opts?.token ?? TEST_TOKEN}`;
    }

    let postData: string | undefined;
    if (opts?.form) {
      postData = new URLSearchParams(opts.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (opts?.body !== undefined) {
      postData = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }

    const req = http.request(
      url,
      { method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body: unknown = data;
          try { body = JSON.parse(data); } catch { /* raw */ }
          resolve({
            statusCode: res.statusCode || 0,
            body,
            headers: res.headers,
            raw: data,
          });
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function postSSE(
  baseUrl: string,
  urlPath: string,
  body: unknown,
): Promise<{ statusCode: number; events: unknown[]; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const postData = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let buf = '';
        const events: unknown[] = [];
        res.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') {
              events.push({ type: 'done_signal' });
              continue;
            }
            try { events.push(JSON.parse(payload)); } catch { /* ignore */ }
          }
        });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, events, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function startTestApp(state: DaemonState, options?: Parameters<typeof createWebApp>[1]) {
  const app = createWebApp(state, {
    apiToken: TEST_TOKEN,
    skipConfig: true,
    host: '127.0.0.1',
    ...options,
  });
  const httpServer = await new Promise<http.Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, httpServer, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopTestApp(httpServer: http.Server) {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}

describe('embedded web server lifecycle', () => {
  let sessionsDir: string;
  let state: DaemonState;

  beforeAll(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-web-unit-'));
    state = createMockState({ sessionsDir });
  });

  afterAll(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await stopEmbeddedWebServer();
  });

  it('reports not running before start', () => {
    expect(isWebServerRunning()).toBe(false);
    expect(getWebServerPort()).toBeNull();
  });

  it('tracks running state and port after start/stop', async () => {
    const port = await getEphemeralPort();
    const started = await startEmbeddedWebServer(state, port, '127.0.0.1', {
      apiToken: TEST_TOKEN,
      skipConfig: true,
      authEnabled: true,
    });

    expect(isWebServerRunning()).toBe(true);
    expect(getWebServerPort()).toBe(port);
    expect(started.port).toBe(port);
    expect(started.url).toBe(`http://127.0.0.1:${port}`);
    expect(started.security.apiToken).toBe(TEST_TOKEN);

    await stopEmbeddedWebServer();
    expect(isWebServerRunning()).toBe(false);
    expect(getWebServerPort()).toBeNull();
  });

  it('returns the existing server when start is called twice', async () => {
    const port = await getEphemeralPort();
    const first = await startEmbeddedWebServer(state, port, '127.0.0.1', {
      apiToken: TEST_TOKEN,
      skipConfig: true,
    });
    const second = await startEmbeddedWebServer(state, 9999, '127.0.0.1', {
      apiToken: TEST_TOKEN,
      skipConfig: true,
    });

    expect(second.port).toBe(first.port);
    expect(second.app).toBe(first.app);
    expect(second.security).toBe(first.security);
  });

  it('warns when auth is disabled on start', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await getEphemeralPort();
    await startEmbeddedWebServer(state, port, '127.0.0.1', {
      apiToken: TEST_TOKEN,
      skipConfig: true,
      authEnabled: false,
    });
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('authentication is DISABLED'))).toBe(true);
    warnSpy.mockRestore();
    await stopEmbeddedWebServer();
  });
});

describe('createWebApp routes', () => {
  let sessionsDir: string;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-web-app-'));
    const state = createMockState({
      sessionsDir,
      providers: [{
        id: 'openai',
        engine: 'openai',
        configured: true,
        healthy: true,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com',
        baseUrl: 'https://api.openai.com',
      } as ProviderInfo],
      models: [{
        id: 'openai/gpt-4o',
        name: 'gpt-4o',
        engineModelId: 'gpt-4o',
        provider: 'openai',
        engine: 'openai',
        contextWindow: 128000,
        capabilities: { supportsTools: true, supportsVision: true },
      } as ModelInfo],
      discoverModels: [{
        id: 'openai/gpt-4o',
        engine: 'openai',
        contextWindow: 128000,
        capabilities: { supportsTools: true, supportsVision: false },
      } as ModelInfo],
      toolRegistryTools: [{
        namespacedName: 'local.echo',
        originalName: 'echo',
        source: 'local',
        sourceType: 'builtin',
        description: 'Echo tool',
      }],
      clients: [{
        clientId: 'c1',
        clientType: 'CLI' as never,
        connectedAt: new Date(),
        isSpawner: false,
        workspacePaths: [],
        workspacePath: '/tmp/ws-fallback',
      }],
      vscodeConnectionIds: ['vscode-1'],
      requestWorkspaceFails: true,
    });
    const started = await startTestApp(state);
    httpServer = started.httpServer;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    if (httpServer) await stopTestApp(httpServer);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    await stopEmbeddedWebServer();
  });

  it('GET /api/health returns daemon status when authenticated', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      daemon: 'connected',
      healthy: true,
      version: '0.1.0-test',
    });
  });

  it('GET /api/health rejects unauthenticated requests', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/health', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/status returns daemon client info when authenticated', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/status');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: '0.1.0-test',
      connectedClients: 1,
    });
    expect((res.body as { clients: unknown[] }).clients).toHaveLength(1);
  });

  it('GET /api/engines lists available engines', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/engines');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('engines');
    expect(Array.isArray((res.body as { engines: unknown[] }).engines)).toBe(true);
  });

  it('GET /api/templates returns provider templates', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/templates');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.body as { templates: unknown[] }).templates)).toBe(true);
  });

  it('GET /api/providers returns configured providers', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/providers');
    expect(res.statusCode).toBe(200);
    expect((res.body as { providers: ProviderInfo[] }).providers[0].id).toBe('openai');
  });

  it('GET /api/models returns model list', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/models');
    expect(res.statusCode).toBe(200);
    expect((res.body as { models: ModelInfo[] }).models[0].id).toBe('openai/gpt-4o');
  });

  it('GET /api/workspaces falls back to client workspace paths', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/workspaces');
    expect(res.statusCode).toBe(200);
    expect((res.body as { workspaces: string[] }).workspaces).toContain('/tmp/ws-fallback');
  });

  it('GET /api/discover-models rejects apiKey query param', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/discover-models/openai?apiKey=secret');
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/query parameter/i);
  });

  it('POST /api/discover-models returns models', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/discover-models/openai', {
      body: { baseUrl: 'https://api.openai.com' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { models: unknown[] }).models).toHaveLength(1);
  });

  it('GET /api/config returns user config shape', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('config');
    expect(res.body).toHaveProperty('path');
  });

  it('GET /api/config rejects non-allowlisted workspace locations', async () => {
    const res = await httpRequest(baseUrl, 'GET', `/api/config?location=${encodeURIComponent('/tmp/not-allowed')}`);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/allowlisted/i);
  });

  it('POST /api/config saves user config', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/config', {
      body: {
        location: 'user',
        config: { providers: { custom: { engine: 'openai' } } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);
  });

  it('GET /v1/models returns OpenAI model list', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/v1/models');
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: Array<{ id: string }> }).data[0].id).toBe('openai/gpt-4o');
  });

  it('POST /v1/chat/completions returns non-streaming completion', async () => {
    const chatState = createMockState({
      sessionsDir,
      chatChunks: [
        { type: 'text', text: 'OpenAI hello' },
        { type: 'done', finishReason: 'stop' },
      ],
    });
    const { httpServer: chatServer, baseUrl: chatBase } = await startTestApp(chatState);
    try {
      const res = await httpRequest(chatBase, 'POST', '/v1/chat/completions', {
        body: {
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(
        (res.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content,
      ).toBe('OpenAI hello');
    } finally {
      await stopTestApp(chatServer);
    }
  });

  it('GET /api/secrets lists engine keys', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/secrets');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.body as { secrets: unknown[] }).secrets)).toBe(true);
  });

  it('POST /api/secrets sets a secret via legacy route', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/secrets', {
      body: { key: 'LEGACY_KEY', value: 'legacy-value' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);
  });

  it('POST /api/secrets/:key sets a secret', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/secrets/MY_KEY', {
      body: { value: 'secret-value' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE /api/secrets/:key deletes a secret', async () => {
    const res = await httpRequest(baseUrl, 'DELETE', '/api/secrets/MY_KEY');
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/key-status checks keychain and env', async () => {
    const keychain = await httpRequest(baseUrl, 'GET', '/api/key-status?source=keychain&name=OPENAI_API_KEY');
    expect(keychain.statusCode).toBe(200);
    const env = await httpRequest(baseUrl, 'GET', '/api/key-status?source=env&name=HOME');
    expect(env.statusCode).toBe(200);
    expect((env.body as { exists: boolean }).exists).toBe(true);
    const bad = await httpRequest(baseUrl, 'GET', '/api/key-status');
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/tools lists registered tools', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/tools');
    expect(res.statusCode).toBe(200);
    expect((res.body as { tools: unknown[] }).tools[0]).toMatchObject({ name: 'local.echo' });
    expect((res.body as { total: number }).total).toBe(1);
  });

  it('GET /api/policies lists built-in policies', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/policies');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.body as { policies: unknown[] }).policies)).toBe(true);
  });

  it('POST and DELETE /api/policies manage custom policies', async () => {
    const created = await httpRequest(baseUrl, 'POST', '/api/policies', {
      body: { name: 'my_custom_policy', config: {} },
    });
    expect(created.statusCode).toBe(200);

    const builtin = await httpRequest(baseUrl, 'POST', '/api/policies', {
      body: { name: 'precise', config: {} },
    });
    expect(builtin.statusCode).toBe(400);

    const deleted = await httpRequest(baseUrl, 'DELETE', '/api/policies/my_custom_policy');
    expect(deleted.statusCode).toBe(200);

    const missing = await httpRequest(baseUrl, 'DELETE', '/api/policies/no_such_policy');
    expect(missing.statusCode).toBe(404);
  });

  it('GET /api/mcp-servers returns configured servers', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/mcp-servers');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('mcp_servers');
  });

  it('POST /api/mcp-servers/:id/reconnect succeeds', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/mcp-servers/test-server/reconnect');
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/mcp-server/status reports running state', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/mcp-server/status');
    expect(res.statusCode).toBe(200);
    expect((res.body as { running: boolean }).running).toBe(false);
  });

  it('POST /api/mcp-server/start and stop manage MCP server', async () => {
    const start = await httpRequest(baseUrl, 'POST', '/api/mcp-server/start');
    expect(start.statusCode).toBe(200);
    const again = await httpRequest(baseUrl, 'POST', '/api/mcp-server/start');
    expect(again.statusCode).toBe(200);
    expect((again.body as { message?: string }).message).toMatch(/already running/i);
    const stop = await httpRequest(baseUrl, 'POST', '/api/mcp-server/stop');
    expect(stop.statusCode).toBe(200);
  });

  it('MCP connection and approval endpoints handle empty and missing requests', async () => {
    const connections = await httpRequest(baseUrl, 'GET', '/api/mcp/connections');
    expect(connections.statusCode).toBe(200);
    expect((connections.body as { pending: unknown[] }).pending).toEqual([]);

    const missingConn = await httpRequest(baseUrl, 'POST', '/api/mcp/connections/missing-id', {
      body: { decision: 'deny' },
    });
    expect(missingConn.statusCode).toBe(404);

    const approvals = await httpRequest(baseUrl, 'GET', '/api/mcp/approvals');
    expect(approvals.statusCode).toBe(200);

    const missingApproval = await httpRequest(baseUrl, 'POST', '/api/mcp/approvals/missing-id', {
      body: { decision: 'deny' },
    });
    expect(missingApproval.statusCode).toBe(404);

    const spawns = await httpRequest(baseUrl, 'GET', '/api/mcp/stdio-spawns');
    expect(spawns.statusCode).toBe(200);
    expect((spawns.body as { denials: unknown[] }).denials).toHaveLength(1);

    const missingSpawn = await httpRequest(baseUrl, 'POST', '/api/mcp/stdio-spawns/missing-id', {
      body: { decision: 'deny' },
    });
    expect(missingSpawn.statusCode).toBe(404);
  });

  it('DELETE /api/mcp/connections endpoints handle sessions and remembered clients', async () => {
    const noSession = await httpRequest(baseUrl, 'DELETE', '/api/mcp/connections/sessions/sess-1');
    expect(noSession.statusCode).toBe(404);

    const noClient = await httpRequest(baseUrl, 'DELETE', '/api/mcp/connections/remembered/unknown-client');
    expect(noClient.statusCode).toBe(404);
  });

  it('session CRUD endpoints work', async () => {
    const created = await httpRequest(baseUrl, 'POST', '/api/sessions', {
      body: { model: 'openai/gpt-4o', title: 'Test session' },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.body as { id: string }).id;

    const list = await httpRequest(baseUrl, 'GET', '/api/sessions');
    expect(list.statusCode).toBe(200);

    const one = await httpRequest(baseUrl, 'GET', `/api/sessions/${id}`);
    expect(one.statusCode).toBe(200);

    const badLimit = await httpRequest(baseUrl, 'GET', '/api/sessions?limit=-1');
    expect(badLimit.statusCode).toBe(400);

    const deleted = await httpRequest(baseUrl, 'DELETE', `/api/sessions/${id}`);
    expect(deleted.statusCode).toBe(200);
  });

  it('POST /api/chat streams SSE events', async () => {
    const { statusCode, events } = await postSSE(baseUrl, '/api/chat', {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(statusCode).toBe(200);
    expect(events.some((e) => (e as { type: string }).type === 'chat_started')).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(true);
  });

  it('POST /api/chat streams tool chunks when provided', async () => {
    const toolState = createMockState({
      sessionsDir,
      chatChunks: [
        {
          type: 'tool',
          name: 'echo',
          state: 'result',
          done: true,
          call: { params: { msg: 'hi' }, result: 'hi' },
        },
        { type: 'done', finishReason: 'stop' },
      ],
    });
    const { httpServer: toolServer, baseUrl: toolBase } = await startTestApp(toolState);
    try {
      const { events } = await postSSE(toolBase, '/api/chat', {
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'run tool' }],
        tools: [{ name: 'echo', description: 'echo', input_schema: {} }],
      });
      expect(events.some((e) => (e as { type: string }).type === 'tool')).toBe(true);
    } finally {
      await stopTestApp(toolServer);
    }
  });

  it('POST /api/sessions/:id/chat streams and persists messages', async () => {
    const chatState = createMockState({
      sessionsDir,
      chatChunks: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' session' },
        { type: 'done', finishReason: 'stop' },
      ],
    });
    const { httpServer: chatServer, baseUrl: chatBase } = await startTestApp(chatState);
    try {
      const created = await httpRequest(chatBase, 'POST', '/api/sessions', {
        body: { model: 'openai/gpt-4o' },
      });
      const id = (created.body as { id: string }).id;
      const { statusCode, events } = await postSSE(chatBase, `/api/sessions/${id}/chat`, {
        message: { role: 'user', content: 'Hi' },
      });
      expect(statusCode).toBe(200);
      expect(events.some((e) => (e as { type: string }).type === 'text')).toBe(true);

      const summary = await httpRequest(chatBase, 'GET', `/api/sessions/${id}/summary`);
      expect(summary.statusCode).toBe(200);
    } finally {
      await stopTestApp(chatServer);
    }
  });

  it('POST /api/chat/:chatId/approve returns 404 for unknown request', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/chat/chat-1/approve', {
      body: { requestId: 'missing', decision: 'allow' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/provider/:id/configure updates provider config', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/provider/openai/configure', {
      body: { engine: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);

    const envOnly = await httpRequest(baseUrl, 'POST', '/api/provider/anthropic/configure', {
      body: { engine: 'anthropic', envVarName: 'ANTHROPIC_API_KEY' },
    });
    expect(envOnly.statusCode).toBe(200);

    const missingEngine = await httpRequest(baseUrl, 'POST', '/api/provider/new-provider/configure', {
      body: { apiKey: 'sk-test' },
    });
    expect(missingEngine.statusCode).toBe(400);
  });

  it('DELETE /api/provider/:id removes provider', async () => {
    await httpRequest(baseUrl, 'POST', '/api/provider/openai/configure', {
      body: { engine: 'openai', apiKey: 'sk-test' },
    });
    const res = await httpRequest(baseUrl, 'DELETE', '/api/provider/openai');
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/mcp-servers includes configured servers from config file', async () => {
    const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-mcp-servers-config-'));
    const configPath = path.join(isolatedConfigDir, 'config.yaml');
    fs.writeFileSync(configPath, 'mcp_servers:\n  myserver:\n    transport: stdio\n    enabled: true\n');
    hoisted.configOverrides.userConfigPath = configPath;
    const mcpState = createMockState({
      sessionsDir,
      mcpPoolStatuses: [{
        id: 'orphan',
        connected: false,
        error: 'down',
        toolCount: 2,
        config: { transport: 'http', enabled: true },
      }],
    });
    const { httpServer: mcpServer, baseUrl: mcpBase } = await startTestApp(mcpState, { skipConfig: false });
    try {
      const res = await httpRequest(mcpBase, 'GET', '/api/mcp-servers');
      expect(res.statusCode).toBe(200);
      const servers = (res.body as { mcp_servers: Array<{ id: string; status: string }> }).mcp_servers;
      expect(servers.some((s) => s.id === 'myserver')).toBe(true);
      expect(servers.some((s) => s.id === 'orphan')).toBe(true);
    } finally {
      await stopTestApp(mcpServer);
      hoisted.configOverrides.userConfigPath = null;
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
    }
  });

  it('GET unknown /api/* path returns JSON 404', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/no-such-route');
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toBe('Not found');
  });

  it('GET /login serves the login form when unauthenticated', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/login', { token: null });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('Sign in');
  });

  it('GET / serves dashboard HTML on localhost without prior cookie', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/', { token: null });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('window.__ABBENAY_CSRF__');
  });

  it('GET /index.html serves dashboard HTML', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/index.html', { token: null });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('window.__ABBENAY_CSRF__');
  });
});

describe('dashboard login HTML flows', () => {
  let sessionsDir: string;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-web-login-'));
    const state = createMockState({ sessionsDir });
    const started = await startTestApp(state);
    httpServer = started.httpServer;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    if (httpServer) await stopTestApp(httpServer);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('POST /login with form body redirects on success', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/login', {
      token: null,
      form: { token: TEST_TOKEN },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('POST /login with invalid form token returns HTML error', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/login', {
      token: null,
      form: { token: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.body)).toContain('Invalid token');
  });

  it('GET /login redirects when auth cookie is already set', async () => {
    const login = await httpRequest(baseUrl, 'POST', '/login', {
      token: null,
      form: { token: TEST_TOKEN },
    });
    const setCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

    const res = await httpRequest(baseUrl, 'GET', '/login', {
      token: null,
      cookie: cookieHeader,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('legacy ?token= login sets cookies and redirects', async () => {
    const res = await httpRequest(baseUrl, 'GET', `/?token=${encodeURIComponent(TEST_TOKEN)}`, {
      token: null,
    });
    expect(res.statusCode).toBe(302);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => c.startsWith(`${API_TOKEN_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(true);
  });

  it('legacy ?token= login rejects invalid token with 401', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/?token=wrong-token', { token: null });
    expect(res.statusCode).toBe(401);
    expect(String(res.body)).toContain('Invalid token');
  });

  it('POST /login with JSON body returns 400 for invalid payload', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/login', {
      token: null,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: { password: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Invalid request body/i);
  });

  it('POST /login with JSON body returns 401 for wrong token', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/login', {
      token: null,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: { token: 'wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('Invalid token');
  });
});

describe('createWebApp error paths', () => {
  let sessionsDir: string;

  beforeAll(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-web-errors-'));
  });

  afterAll(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('GET /api/providers returns 500 when listProviders throws', async () => {
    const state = createMockState({ sessionsDir, throwOnListProviders: true });
    const { httpServer, baseUrl } = await startTestApp(state);
    try {
      const res = await httpRequest(baseUrl, 'GET', '/api/providers');
      expect(res.statusCode).toBe(500);
    } finally {
      await stopTestApp(httpServer);
    }
  });
});
