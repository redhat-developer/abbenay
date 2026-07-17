/**
 * Integration tests: HTTP API secure defaults
 *
 * - Unauthenticated requests → 401
 * - Valid Bearer → success
 * - Foreign Origin → CORS reject
 * - Bind address defaults to 127.0.0.1
 * - Session list/get denied without auth
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWebApp, startEmbeddedWebServer, stopEmbeddedWebServer } from '../../src/daemon/web/server.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';
import { SessionStore } from '../../src/core/session-store.js';
import { DEFAULT_HTTP_HOST } from '../../src/core/constants.js';

const TEST_TOKEN = 'test-http-api-token-secure-defaults';

const mockSecretStore: SecretStore = {
  async get() { return null; },
  async set() {},
  async delete() { return true; },
  async has() { return false; },
};

let sessionsDir: string;
let httpServer: http.Server;
let baseUrl: string;
let appPort: number;

function createMockState(): DaemonState {
  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore: mockSecretStore,
    sessionStore: new SessionStore(sessionsDir),
    async listProviders() { return []; },
    async listModels() { return []; },
    async discoverModels() { return []; },
    async resolveProviderCredentials() { return {}; },
    async chat() { return (async function* () { yield { type: 'done' as const, finishReason: 'stop' }; })(); },
    getStatus() {
      return { version: '0.1.0-test', uptime: 0, providers: 0, models: 0 };
    },
    getConnectedClients() { return []; },
    mcpClientPool: {
      getAllStatus() { return []; },
      async reconnect() {},
    },
    toolRegistry: {
      listTools() { return []; },
    },
    mcpServer: {
      isRunning() { return false; },
      async start() {},
      async stop() {},
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
): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlPath, baseUrl);
    const headers: Record<string, string> = {
      Connection: 'close',
      ...(opts?.headers || {}),
    };
    if (opts?.token !== null && opts?.token !== undefined) {
      headers.Authorization = `Bearer ${opts.token}`;
    } else if (opts?.token === undefined) {
      // default: authenticated
      headers.Authorization = `Bearer ${TEST_TOKEN}`;
    }
    // token: null → no Authorization

    let postData: string | undefined;
    if (opts?.body !== undefined) {
      postData = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(postData));
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
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body: any = data;
          try { body = JSON.parse(data); } catch { /* raw */ }
          resolve({ statusCode: res.statusCode || 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

beforeAll(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-sec-sessions-'));
  const state = createMockState();
  const app = createWebApp(state, {
    apiToken: TEST_TOKEN,
    skipConfig: true,
    host: '127.0.0.1',
  });

  appPort = await new Promise<number>((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  baseUrl = `http://127.0.0.1:${appPort}`;
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  await stopEmbeddedWebServer();
});

describe('HTTP auth', () => {
  it('rejects unauthenticated GET /api/secrets', async () => {
    const res = await httpRequest('GET', '/api/secrets', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated GET /api/sessions', async () => {
    const res = await httpRequest('GET', '/api/sessions', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated GET /api/sessions/:id', async () => {
    const res = await httpRequest('GET', '/api/sessions/does-not-exist', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated GET /v1/models', async () => {
    const res = await httpRequest('GET', '/v1/models', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated POST /mcp', async () => {
    const res = await httpRequest('POST', '/mcp', {
      token: null,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows authenticated GET /api/secrets', async () => {
    const res = await httpRequest('GET', '/api/secrets');
    expect(res.statusCode).toBe(200);
  });

  it('allows authenticated GET /api/sessions', async () => {
    const res = await httpRequest('GET', '/api/sessions');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('sessions');
  });

  it('rejects wrong Bearer token', async () => {
    const res = await httpRequest('GET', '/api/health', { token: 'wrong-token' });
    expect(res.statusCode).toBe(401);
  });

  it('isolates sessions by X-Abbenay-Session-Owner claim', async () => {
    const createA = await httpRequest('POST', '/api/sessions', {
      body: { model: 'mock/model', title: 'Owner A' },
      headers: { 'X-Abbenay-Session-Owner': 'app-a' },
    });
    expect(createA.statusCode).toBe(200);
    const idA = createA.body.id;

    const createB = await httpRequest('POST', '/api/sessions', {
      body: { model: 'mock/model', title: 'Owner B' },
      headers: { 'X-Abbenay-Session-Owner': 'app-b' },
    });
    expect(createB.statusCode).toBe(200);

    const listA = await httpRequest('GET', '/api/sessions', {
      headers: { 'X-Abbenay-Session-Owner': 'app-a' },
    });
    expect(listA.statusCode).toBe(200);
    expect(listA.body.sessions).toHaveLength(1);
    expect(listA.body.sessions[0].title).toBe('Owner A');

    const crossRead = await httpRequest('GET', `/api/sessions/${idA}`, {
      headers: { 'X-Abbenay-Session-Owner': 'app-b' },
    });
    expect(crossRead.statusCode).toBe(404);
  });
});

describe('ABBENAY_HTTP_AUTH disable escape hatch', () => {
  let disabledServer: http.Server;
  let disabledBase: string;

  beforeAll(async () => {
    const state = createMockState();
    const app = createWebApp(state, {
      authEnabled: false,
      skipConfig: true,
      host: '127.0.0.1',
    });
    const port = await new Promise<number>((resolve) => {
      disabledServer = app.listen(0, '127.0.0.1', () => {
        const addr = disabledServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    disabledBase = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (disabledServer) {
      await new Promise<void>((resolve) => disabledServer.close(() => resolve()));
    }
  });

  it('allows unauthenticated requests when authEnabled is false', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${disabledBase}/api/health`,
        { method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it('allows unauthenticated session list when auth is disabled', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${disabledBase}/api/sessions`,
        { method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it('refuses to start when auth is disabled on a non-loopback bind', async () => {
    await stopEmbeddedWebServer();
    const state = createMockState();
    await expect(
      startEmbeddedWebServer(state, 18787, '0.0.0.0', {
        authEnabled: false,
        skipConfig: true,
      }),
    ).rejects.toThrow(/authentication disabled|ABBENAY_HTTP_AUTH/);
    await stopEmbeddedWebServer();
  });

  it('allows auth-disabled start on loopback', async () => {
    await stopEmbeddedWebServer();
    const state = createMockState();
    const probe = http.createServer();
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const started = await startEmbeddedWebServer(state, freePort, '127.0.0.1', {
      authEnabled: false,
      skipConfig: true,
    });
    expect(started.security.authEnabled).toBe(false);
    expect(started.security.host).toBe('127.0.0.1');
    await stopEmbeddedWebServer();
  });
});

describe('dashboard login', () => {
  it('POST /login sets auth cookies with JSON body', async () => {
    const res = await httpRequest('POST', '/login', {
      token: null,
      body: { token: TEST_TOKEN },
      headers: { Accept: 'application/json' },
    });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => c.startsWith('abbenay_api_token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('abbenay_csrf='))).toBe(true);
  });

  it('POST /login rejects invalid token', async () => {
    const res = await httpRequest('POST', '/login', {
      token: null,
      body: { token: 'wrong-token' },
      headers: { Accept: 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /login sets Secure cookies behind X-Forwarded-Proto https', async () => {
    const res = await httpRequest('POST', '/login', {
      token: null,
      body: { token: TEST_TOKEN },
      headers: {
        Accept: 'application/json',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.every((c) => /;\s*Secure/i.test(c))).toBe(true);
  });

  it('legacy ?token= login redirects and sets cookies (timing-safe path)', async () => {
    const res = await httpRequest('GET', `/?token=${encodeURIComponent(TEST_TOKEN)}`, {
      token: null,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => c.startsWith('abbenay_api_token='))).toBe(true);
  });

  it('legacy ?token= rejects invalid token', async () => {
    const res = await httpRequest('GET', '/?token=not-the-token', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('GET /login serves a token form when unauthenticated', async () => {
    const res = await httpRequest('GET', '/login', { token: null });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('action="/login"');
    expect(String(res.body)).toContain('name="token"');
  });

  it('GET / on localhost bind still serves the dashboard without a prior cookie', async () => {
    // Default test bind is 127.0.0.1 — auto-session for local use (no redirect).
    const res = await httpRequest('GET', '/', { token: null });
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('Abbenay');
  });
});

describe('CORS allowlist', () => {
  it('rejects foreign Origin on preflight', async () => {
    const res = await httpRequest('OPTIONS', '/api/health', {
      token: null,
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects foreign Origin on actual request', async () => {
    const res = await httpRequest('GET', '/api/health', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows allowlisted localhost Origin', async () => {
    // createWebApp defaults port to 8787 for CORS allowlist construction
    const origin = 'http://127.0.0.1:8787';
    const res = await httpRequest('GET', '/api/health', {
      headers: { Origin: origin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });
});

describe('bind address default', () => {
  it('exports DEFAULT_HTTP_HOST as 127.0.0.1', () => {
    expect(DEFAULT_HTTP_HOST).toBe('127.0.0.1');
  });

  it('startEmbeddedWebServer listens on 127.0.0.1 by default', async () => {
    // Use a separate state + ephemeral port; stop any prior embedded server first
    await stopEmbeddedWebServer();
    const state = createMockState();
    const result = await startEmbeddedWebServer(state, 0 as unknown as number, undefined, {
      apiToken: TEST_TOKEN,
      skipConfig: true,
    });
    // port 0 may not work with our listen — use a high free port instead
    await stopEmbeddedWebServer();

    // Pick an ephemeral port via a probe, then start embedded on that port
    const probe = http.createServer();
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const started = await startEmbeddedWebServer(state, freePort, undefined, {
      apiToken: TEST_TOKEN,
      skipConfig: true,
    });

    expect(started.security.host).toBe('127.0.0.1');
    expect(started.url).toContain('127.0.0.1');

    // Confirm we can connect on loopback
    const ok = await httpRequest('GET', `http://127.0.0.1:${freePort}/api/health`).catch(() => null);
    // httpRequest uses baseUrl — do a direct request
    const direct = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: freePort,
          path: '/api/health',
          method: 'GET',
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(direct).toBe(200);

    // Non-loopback connect should fail when bound to 127.0.0.1 only —
    // skip if no alternate interface; at least assert bind host.
    expect(started.security.host).toBe(DEFAULT_HTTP_HOST);
    void ok;
    void result;

    await stopEmbeddedWebServer();
  });
});
