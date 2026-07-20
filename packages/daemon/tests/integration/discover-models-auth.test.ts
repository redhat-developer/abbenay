/**
 * Integration tests: discover-models API key transport
 *
 * - Rejects ?apiKey= query param (400)
 * - Accepts X-Api-Key header
 * - Accepts JSON body apiKey (POST)
 * - Does not use query apiKey when only that is supplied
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWebApp } from '../../src/daemon/web/server.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';
import { SessionStore } from '../../src/core/session-store.js';

const TEST_TOKEN = 'test-discover-models-auth-token';

const mockSecretStore: SecretStore = {
  async get() { return null; },
  async set() {},
  async delete() { return true; },
  async has() { return false; },
};

let sessionsDir: string;
let httpServer: http.Server;
let baseUrl: string;
let lastDiscoverArgs: { engineId: string; apiKey?: string; baseUrl?: string } | null = null;

function createMockState(): DaemonState {
  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore: mockSecretStore,
    sessionStore: new SessionStore(sessionsDir),
    async listProviders() { return []; },
    async listModels() { return []; },
    async discoverModels(engineId: string, apiKey?: string, baseUrl?: string) {
      lastDiscoverArgs = { engineId, apiKey, baseUrl };
      return [{
        id: 'gemini-2.0-flash',
        engine: engineId,
        contextWindow: 1048576,
        capabilities: { supportsTools: true, supportsVision: true },
      }];
    },
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
  },
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlPath, baseUrl);
    const headers: Record<string, string> = {
      Connection: 'close',
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(opts?.headers || {}),
    };

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
          resolve({ statusCode: res.statusCode || 0, body });
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

beforeAll(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-discover-auth-'));
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
});

describe('discover-models API key transport', () => {
  it('rejects apiKey query parameter with 400', async () => {
    lastDiscoverArgs = null;
    const res = await httpRequest(
      'GET',
      '/api/discover-models/gemini?apiKey=should-not-be-used',
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/must not be passed as a query parameter/i);
    expect(lastDiscoverArgs).toBeNull();
  });

  it('accepts API key via X-Api-Key header on GET', async () => {
    lastDiscoverArgs = null;
    const res = await httpRequest('GET', '/api/discover-models/gemini', {
      headers: { 'X-Api-Key': 'header-secret-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(lastDiscoverArgs).toEqual({
      engineId: 'gemini',
      apiKey: 'header-secret-key',
      baseUrl: undefined,
    });
  });

  it('accepts API key via JSON body on POST', async () => {
    lastDiscoverArgs = null;
    const res = await httpRequest('POST', '/api/discover-models/gemini', {
      body: { apiKey: 'body-secret-key', baseUrl: 'https://example.invalid' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(lastDiscoverArgs).toEqual({
      engineId: 'gemini',
      apiKey: 'body-secret-key',
      baseUrl: 'https://example.invalid',
    });
  });

  it('prefers X-Api-Key header over body apiKey', async () => {
    lastDiscoverArgs = null;
    const res = await httpRequest('POST', '/api/discover-models/gemini', {
      headers: { 'X-Api-Key': 'from-header' },
      body: { apiKey: 'from-body' },
    });
    expect(res.statusCode).toBe(200);
    expect(lastDiscoverArgs?.apiKey).toBe('from-header');
  });

  it('does not accept key material from query when only ?apiKey= is supplied', async () => {
    lastDiscoverArgs = null;
    const res = await httpRequest(
      'POST',
      '/api/discover-models/gemini?apiKey=query-only-secret',
      { body: {} },
    );
    expect(res.statusCode).toBe(400);
    expect(lastDiscoverArgs).toBeNull();
  });
});
