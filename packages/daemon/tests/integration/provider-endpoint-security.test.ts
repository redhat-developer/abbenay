/**
 * E2E: provider endpoint / secret configure hardening (AAP-82836 / A1,A3).
 *
 * Acceptance:
 * 1. Unauthenticated configure of provider base URL → denied (401)
 * 2. Authenticated configure with disallowed/malformed endpoint → rejected (400)
 * 3. Authenticated configure with allowed endpoint → succeeds and is audited
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-endpoint-sec-'));
vi.mock('../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/paths.js')>();
  return {
    ...actual,
    getUserConfigPath: () => path.join(tmpConfigDir, 'config.yaml'),
    getWorkspaceConfigPath: (wsPath: string) => path.join(wsPath, '.config', 'abbenay', 'config.yaml'),
    getConfigDir: () => tmpConfigDir,
  };
});

import { createWebApp } from '../../src/daemon/web/server.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';
import { SessionStore } from '../../src/core/session-store.js';

const TEST_TOKEN = 'test-provider-endpoint-token';

const mockSecretStore: SecretStore = {
  async get() { return null; },
  async set() {},
  async delete() { return true; },
  async has() { return false; },
};

let sessionsDir: string;
let httpServer: http.Server;
let baseUrl: string;
let infoSpy: ReturnType<typeof vi.spyOn>;

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
    async chat() {
      return (async function* () { yield { type: 'done' as const, finishReason: 'stop' }; })();
    },
    getStatus() {
      return { version: '0.1.0-test', uptime: 0, providers: 0, models: 0 };
    },
    getConnectedClients() { return []; },
    getVSCodeWorkspaces() { return []; },
    notifyModelsChanged() {},
    refreshMcpConnections: async () => {},
    mcpClientPool: {
      getAllStatus() { return []; },
      getStatuses() { return []; },
      async reconnect() {},
    },
    toolRegistry: { listTools() { return []; } },
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
      headers.Authorization = `Bearer ${TEST_TOKEN}`;
    }

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
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-endpoint-sessions-'));
  fs.writeFileSync(path.join(tmpConfigDir, 'config.yaml'), 'providers: {}\n');

  const state = createMockState();
  const app = createWebApp(state, {
    apiToken: TEST_TOKEN,
    skipConfig: true,
    host: '127.0.0.1',
  });

  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  fs.writeFileSync(path.join(tmpConfigDir, 'config.yaml'), 'providers: {}\n');
});

afterEach(() => {
  infoSpy.mockRestore();
});

describe('Provider endpoint security (A1/A3)', () => {
  it('denies unauthenticated configure of provider base URL', async () => {
    const res = await httpRequest('POST', '/api/provider/evil/configure', {
      token: null,
      body: { engine: 'openai', baseUrl: 'https://api.openai.com/v1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('denies unauthenticated secret writes', async () => {
    const res = await httpRequest('POST', '/api/secrets', {
      token: null,
      body: { key: 'OPENAI_API_KEY', value: 'sk-test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('denies unauthenticated secret reads (list)', async () => {
    const res = await httpRequest('GET', '/api/secrets', { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('lists secret presence only (never values) and audits authenticated set', async () => {
    const list = await httpRequest('GET', '/api/secrets');
    expect(list.statusCode).toBe(200);
    expect(list.body).toHaveProperty('secrets');
    for (const s of list.body.secrets) {
      expect(s).toHaveProperty('key');
      expect(s).toHaveProperty('hasValue');
      expect(s).not.toHaveProperty('value');
      expect(JSON.stringify(s)).not.toMatch(/sk-/);
    }

    const set = await httpRequest('POST', '/api/secrets', {
      body: { key: 'OPENAI_API_KEY', value: 'sk-should-never-appear-in-logs' },
    });
    expect(set.statusCode).toBe(200);

    const auditLines = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[Audit] secret changed'));
    expect(auditLines.some((l) =>
      l.includes('key=OPENAI_API_KEY') &&
      l.includes('op=set') &&
      l.includes('source=http-secrets'),
    )).toBe(true);
    expect(auditLines.every((l) => !l.includes('sk-should-never-appear-in-logs'))).toBe(true);
  });

  it('rejects authenticated configure with malformed endpoint', async () => {
    const res = await httpRequest('POST', '/api/provider/bad/configure', {
      body: { engine: 'openai', baseUrl: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/valid absolute URL|Invalid request body/i);
  });

  it('rejects authenticated configure with disallowed http non-loopback endpoint', async () => {
    const res = await httpRequest('POST', '/api/provider/steal/configure', {
      body: { engine: 'openai', baseUrl: 'http://evil.example/steal' },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/loopback|http provider endpoints/i);
  });

  it('rejects authenticated configure with credentials in URL', async () => {
    const res = await httpRequest('POST', '/api/provider/cred/configure', {
      body: { engine: 'openai', baseUrl: 'https://user:pass@api.example.com/v1' },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/credentials/i);
  });

  it('accepts authenticated configure with allowed https endpoint and audits', async () => {
    const res = await httpRequest('POST', '/api/provider/corp-openai/configure', {
      body: {
        engine: 'openai',
        baseUrl: 'https://corp-proxy.example.com/v1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const saved = fs.readFileSync(path.join(tmpConfigDir, 'config.yaml'), 'utf-8');
    expect(saved).toContain('corp-proxy.example.com');

    const auditLines = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[Audit] provider endpoint changed'));
    expect(auditLines.length).toBeGreaterThanOrEqual(1);
    expect(auditLines.some((l) =>
      l.includes('provider=corp-openai') &&
      l.includes('to=https://corp-proxy.example.com/v1') &&
      l.includes('source=http-configure'),
    )).toBe(true);
  });

  it('accepts authenticated configure with loopback http endpoint', async () => {
    const res = await httpRequest('POST', '/api/provider/local-ollama/configure', {
      body: {
        engine: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects POST /api/config with disallowed provider endpoint', async () => {
    const res = await httpRequest('POST', '/api/config', {
      body: {
        location: 'user',
        config: {
          providers: {
            evil: { engine: 'openai', base_url: 'http://evil.example/v1' },
          },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/loopback|provider|Invalid request body/i);
  });

  it('enforces existing allowed_provider_hosts when POST /api/config omits server', async () => {
    fs.writeFileSync(
      path.join(tmpConfigDir, 'config.yaml'),
      [
        'server:',
        '  allowed_provider_hosts:',
        '    - approved.example',
        'providers: {}',
        '',
      ].join('\n'),
    );

    const rejected = await httpRequest('POST', '/api/config', {
      body: {
        location: 'user',
        config: {
          providers: {
            evil: { engine: 'openai', base_url: 'https://evil.example/v1' },
          },
        },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(String(rejected.body.error)).toMatch(/allowed_provider_hosts|Invalid request body/i);

    const accepted = await httpRequest('POST', '/api/config', {
      body: {
        location: 'user',
        config: {
          providers: {
            ok: { engine: 'openai', base_url: 'https://approved.example/v1' },
          },
        },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.success).toBe(true);

    const saved = fs.readFileSync(path.join(tmpConfigDir, 'config.yaml'), 'utf-8');
    expect(saved).toContain('approved.example');
    expect(saved).toMatch(/allowed_provider_hosts/);
    expect(saved).not.toContain('evil.example');
  });

  it('rejects configure with unknown engine (A3 — no arbitrary runtime packages)', async () => {
    const res = await httpRequest('POST', '/api/provider/evil/configure', {
      body: {
        engine: 'not-a-real-engine',
        baseUrl: 'https://api.openai.com/v1',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/unknown engine|allowlist/i);
  });

  it('rejects POST /api/config with unknown engine', async () => {
    const res = await httpRequest('POST', '/api/config', {
      body: {
        location: 'user',
        config: {
          providers: {
            evil: { engine: 'totally-fake-sdk-package' },
          },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/unknown engine|allowlist/i);
  });
});
