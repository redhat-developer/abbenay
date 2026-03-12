/**
 * Integration tests: Session REST endpoints
 *
 * Tests session CRUD and session chat SSE with a mock DaemonState
 * and real Express server (same pattern as web-sse.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWebApp } from '../../src/daemon/web/server.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { ProviderInfo, ModelInfo } from '../../src/core/state.js';
import type { ConnectedClient } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';
import { SessionStore } from '../../src/core/session-store.js';

// ─── Mock DaemonState ───────────────────────────────────────────────────

type MockChunk =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: string; call?: { params: unknown; result: unknown }; done: boolean }
  | { type: 'done'; finishReason: string };

let mockChatResponse: MockChunk[] = [
  { type: 'text', text: 'Hello' },
  { type: 'text', text: ' world' },
  { type: 'done', finishReason: 'stop' },
];

const mockSecretStore: SecretStore = {
  async get() { return null; },
  async set() {},
  async delete() { return true; },
  async has() { return false; },
};

let sessionsDir: string;

function createMockState(): DaemonState {
  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore: mockSecretStore,
    sessionStore: new SessionStore(sessionsDir),

    get clientCount() { return 0; },
    getClients(): ConnectedClient[] { return []; },
    getVSCodeWorkspaces(): string[] { return []; },
    notifyModelsChanged() {},

    async listProviders(): Promise<ProviderInfo[]> { return []; },
    async listModels(): Promise<ModelInfo[]> {
      return [
        { id: 'test/model', name: 'model', engineModelId: 'model', provider: 'test', engine: 'test', contextWindow: 8000 },
      ] as ModelInfo[];
    },

    async* chat(_model: string, _messages: Array<{ role: string; content: string }>) {
      for (const chunk of mockChatResponse) {
        yield chunk;
      }
    },
  } as any as DaemonState;
}

// ─── Test Setup ─────────────────────────────────────────────────────────

let httpServer: http.Server;
let baseUrl: string;

beforeAll(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-sessions-integ-'));
  const state = createMockState();
  const app = createWebApp(state);

  const port = await new Promise<number>((resolve) => {
    httpServer = app.listen(0, () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  if (sessionsDir) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  mockChatResponse = [
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' world' },
    { type: 'done', finishReason: 'stop' },
  ];
});

// ─── HTTP Helpers ───────────────────────────────────────────────────────

function httpRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = body ? JSON.stringify(body) : '';

    const headers: Record<string, string> = { Connection: 'close' };
    if (body) {
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
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode || 0, body: data });
          }
        });
      },
    );

    req.on('error', reject);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('timeout'));
    }, 5000);
    req.on('close', () => clearTimeout(timer));
    if (postData) req.write(postData);
    req.end();
  });
}

function postSSE(
  url: string,
  body: unknown,
): Promise<{ events: any[]; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    let buffer = '';

    const postData = JSON.stringify(body);
    const urlObj = new URL(url);

    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(postData)),
        },
      },
      (res) => {
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.substring(6);
            if (data === '[DONE]') {
              events.push({ type: 'done_signal' });
            } else {
              try {
                events.push(JSON.parse(data));
              } catch { /* ignore */ }
            }
          }
        });

        res.on('end', () => {
          resolve({ events, statusCode: res.statusCode || 0 });
        });
      },
    );

    req.on('error', reject);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timeout'));
    }, 10000);
    req.on('close', () => clearTimeout(timer));
    req.write(postData);
    req.end();
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Session CRUD endpoints', () => {
  it('POST /api/sessions creates a session', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/sessions`, {
      model: 'test/model',
      title: 'Integration Test',
    });

    expect(statusCode).toBe(200);
    expect(body.id).toBeTruthy();
    expect(body.model).toBe('test/model');
    expect(body.title).toBe('Integration Test');
    expect(body.messages).toEqual([]);
  });

  it('POST /api/sessions returns 400 without model', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/sessions`, {
      title: 'No Model',
    });

    expect(statusCode).toBe(400);
    expect(body.error).toContain('model');
  });

  it('GET /api/sessions lists sessions', async () => {
    await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model', title: 'List Test' });

    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/sessions`);

    expect(statusCode).toBe(200);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(body.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/sessions/:id returns session with messages', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/sessions/${id}`);

    expect(statusCode).toBe(200);
    expect(body.id).toBe(id);
    expect(body.messages).toEqual([]);
  });

  it('GET /api/sessions/:id?includeMessages=false omits messages', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    const { statusCode, body } = await httpRequest(
      'GET',
      `${baseUrl}/api/sessions/${id}?includeMessages=false`,
    );

    expect(statusCode).toBe(200);
    expect(body.id).toBe(id);
    expect(body.messages).toEqual([]);
  });

  it('GET /api/sessions/:id returns 404 for unknown ID', async () => {
    const { statusCode } = await httpRequest('GET', `${baseUrl}/api/sessions/nonexistent`);
    expect(statusCode).toBe(404);
  });

  it('DELETE /api/sessions/:id deletes session', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    const { statusCode, body } = await httpRequest('DELETE', `${baseUrl}/api/sessions/${id}`);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);

    const { statusCode: getStatus } = await httpRequest('GET', `${baseUrl}/api/sessions/${id}`);
    expect(getStatus).toBe(404);
  });

  it('DELETE /api/sessions/:id returns 404 for unknown ID', async () => {
    const { statusCode } = await httpRequest('DELETE', `${baseUrl}/api/sessions/nonexistent`);
    expect(statusCode).toBe(404);
  });
});

describe('Session chat SSE endpoint', () => {
  it('POST /api/sessions/:id/chat streams response and persists messages', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    mockChatResponse = [
      { type: 'text', text: 'Session' },
      { type: 'text', text: ' response' },
      { type: 'done', finishReason: 'stop' },
    ];

    const { events, statusCode } = await postSSE(`${baseUrl}/api/sessions/${id}/chat`, {
      message: { role: 'user', content: 'Hello session' },
    });

    expect(statusCode).toBe(200);

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].content).toBe('Session');
    expect(textEvents[1].content).toBe(' response');

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);

    // Verify messages were persisted
    const { body: session } = await httpRequest('GET', `${baseUrl}/api/sessions/${id}`);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('Hello session');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].content).toBe('Session response');
  });

  it('POST /api/sessions/:id/chat returns 400 without message', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/sessions/${id}/chat`, {});
    expect(statusCode).toBe(400);
    expect(body.error).toContain('message');
  });

  it('POST /api/sessions/:id/chat persists tool calls and results', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    mockChatResponse = [
      { type: 'tool', name: 'readFile', state: 'running', done: false },
      { type: 'tool', name: 'readFile', state: 'completed', call: { params: { path: '/tmp/test.txt' }, result: 'file contents here' }, done: true },
      { type: 'text', text: 'I read the file for you.' },
      { type: 'done', finishReason: 'stop' },
    ];

    const { events, statusCode } = await postSSE(`${baseUrl}/api/sessions/${id}/chat`, {
      message: { role: 'user', content: 'Read /tmp/test.txt' },
    });

    expect(statusCode).toBe(200);

    // Should have tool events in the SSE stream
    const toolEvents = events.filter((e) => e.type === 'tool');
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);

    // Verify persisted messages include tool call data
    const { body: session } = await httpRequest('GET', `${baseUrl}/api/sessions/${id}`);

    // Expected: user msg, assistant tool_calls msg, tool result msg, assistant text msg
    expect(session.messages).toHaveLength(4);

    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('Read /tmp/test.txt');

    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].tool_calls).toBeDefined();
    expect(session.messages[1].tool_calls[0].function.name).toBe('readFile');

    expect(session.messages[2].role).toBe('tool');
    expect(session.messages[2].tool_call_id).toBeTruthy();
    expect(session.messages[2].content).toBe('file contents here');

    expect(session.messages[3].role).toBe('assistant');
    expect(session.messages[3].content).toBe('I read the file for you.');
  });

  it('POST /api/sessions/:id/chat auto-titles on first turn', async () => {
    const created = await httpRequest('POST', `${baseUrl}/api/sessions`, { model: 'test/model' });
    const id = created.body.id;

    await postSSE(`${baseUrl}/api/sessions/${id}/chat`, {
      message: { role: 'user', content: 'What is the meaning of life?' },
    });

    const { body: session } = await httpRequest('GET', `${baseUrl}/api/sessions/${id}`);
    expect(session.title).toBe('What is the meaning of life?');
  });
});
