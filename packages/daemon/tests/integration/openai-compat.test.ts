/**
 * OpenAI-compatible API integration tests
 *
 * Tests the /v1/models and /v1/chat/completions endpoints against
 * a real Express server with a mock DaemonState (same pattern as
 * web-sse.test.ts). Verifies OpenAI wire format compliance for
 * streaming, non-streaming, error handling, and tool calls.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { createWebApp } from '../../src/daemon/web/server.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { ProviderInfo, ModelInfo } from '../../src/core/state.js';
import type { ConnectedClient } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';

// ── Mock DaemonState ────────────────────────────────────────────────────

interface MockChatConfig {
  chunks: Array<{ type: 'text'; text: string } | { type: 'tool'; name: string; state: string; call?: { params: unknown; result: unknown }; done: boolean } | { type: 'done'; finishReason: string } | { type: 'error'; error: string }>;
  chunkDelayMs: number;
  throwError?: string;
}

let mockChatConfig: MockChatConfig = {
  chunks: [
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' world' },
    { type: 'done', finishReason: 'stop' },
  ],
  chunkDelayMs: 0,
};

const mockSecretStore: SecretStore = {
  async get() { return null; },
  async set() {},
  async delete() { return true; },
  async has() { return false; },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createMockState(): DaemonState {
  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore: mockSecretStore,
    get clientCount() { return 0; },
    getClients(): ConnectedClient[] { return []; },
    getVSCodeWorkspaces(): string[] { return []; },
    notifyModelsChanged(): void {},

    async listProviders(): Promise<ProviderInfo[]> {
      return [
        { id: 'openai', engine: 'openai', displayName: 'OpenAI', configured: true, healthy: true, requiresKey: true },
      ] as ProviderInfo[];
    },

    async listModels(): Promise<ModelInfo[]> {
      return [
        { id: 'openai/gpt-4o', name: 'gpt-4o', engineModelId: 'gpt-4o', provider: 'openai', engine: 'openai', contextWindow: 128000, capabilities: { supportsTools: true, supportsVision: true } },
        { id: 'anthropic/claude-3', name: 'claude-3', engineModelId: 'claude-3', provider: 'anthropic', engine: 'anthropic', contextWindow: 200000 },
      ] as ModelInfo[];
    },

    async* chat() {
      if (mockChatConfig.throwError) {
        throw new Error(mockChatConfig.throwError);
      }
      for (const chunk of mockChatConfig.chunks) {
        yield chunk;
        if (mockChatConfig.chunkDelayMs > 0) await sleep(mockChatConfig.chunkDelayMs);
      }
    },
  } as any as DaemonState;
}

// ── Test Setup ──────────────────────────────────────────────────────────

let httpServer: http.Server;
let baseUrl: string;

beforeAll(async () => {
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
});

beforeEach(() => {
  mockChatConfig = {
    chunks: [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'done', finishReason: 'stop' },
    ],
    chunkDelayMs: 0,
  };
});

// ── HTTP helpers ────────────────────────────────────────────────────────

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
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) }); }
        catch { resolve({ statusCode: res.statusCode || 0, body: data }); }
      });
    });
    req.on('error', reject);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 5000);
    req.on('close', () => clearTimeout(timer));
    if (postData) req.write(postData);
    req.end();
  });
}

function postSSE(
  url: string,
  body: unknown,
): Promise<{ events: any[]; statusCode: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    let buffer = '';
    const postData = JSON.stringify(body);
    const urlObj = new URL(url);

    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(postData)),
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const headers = res.headers;
      res.setEncoding('utf-8');

      res.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.substring(6);
            if (data === '[DONE]') {
              events.push({ _done: true });
            } else {
              try { events.push(JSON.parse(data)); }
              catch { events.push({ _raw: data }); }
            }
          }
        }
      });

      res.on('end', () => resolve({ events, statusCode, headers }));
      res.on('error', (err) => reject(err));
    });

    req.on('error', reject);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 10000);
    req.on('close', () => clearTimeout(timer));
    req.write(postData);
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('GET /v1/models', () => {
  it('returns models in OpenAI list format', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/v1/models`);
    expect(statusCode).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
  });

  it('each model has id, object, owned_by', async () => {
    const { body } = await httpRequest('GET', `${baseUrl}/v1/models`);
    for (const model of body.data) {
      expect(model).toHaveProperty('id');
      expect(model.object).toBe('model');
      expect(model).toHaveProperty('owned_by');
      expect(typeof model.created).toBe('number');
    }
  });

  it('maps owned_by from engine', async () => {
    const { body } = await httpRequest('GET', `${baseUrl}/v1/models`);
    const openai = body.data.find((m: any) => m.id === 'openai/gpt-4o');
    const anthropic = body.data.find((m: any) => m.id === 'anthropic/claude-3');
    expect(openai.owned_by).toBe('openai');
    expect(anthropic.owned_by).toBe('anthropic');
  });
});

describe('POST /v1/chat/completions (streaming)', () => {
  it('streams text chunks in OpenAI format', async () => {
    const { events, statusCode, headers } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    expect(statusCode).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');

    const chunks = events.filter(e => e.choices);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(chunks[0].model).toBe('openai/gpt-4o');
  });

  it('first chunk includes role: assistant', async () => {
    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const firstChunk = events.find(e => e.choices?.[0]?.delta?.content);
    expect(firstChunk.choices[0].delta.role).toBe('assistant');
  });

  it('intermediate chunks have content but no role', async () => {
    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const contentChunks = events.filter(e => e.choices?.[0]?.delta?.content);
    expect(contentChunks).toHaveLength(2);
    expect(contentChunks[0].choices[0].delta.content).toBe('Hello');
    expect(contentChunks[1].choices[0].delta.content).toBe(' world');
    expect(contentChunks[1].choices[0].delta.role).toBeUndefined();
  });

  it('last content chunk has finish_reason: stop', async () => {
    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const doneChunk = events.find(e => e.choices?.[0]?.finish_reason === 'stop');
    expect(doneChunk).toBeDefined();
    expect(doneChunk.choices[0].delta).toEqual({});
  });

  it('stream ends with data: [DONE]', async () => {
    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const doneSignals = events.filter(e => e._done);
    expect(doneSignals).toHaveLength(1);
  });

  it('each chunk has consistent id and model', async () => {
    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const chunks = events.filter(e => e.id);
    const ids = new Set(chunks.map(c => c.id));
    expect(ids.size).toBe(1);
    for (const c of chunks) {
      expect(c.model).toBe('openai/gpt-4o');
      expect(c.id).toMatch(/^chatcmpl-/);
    }
  });
});

describe('POST /v1/chat/completions (non-streaming)', () => {
  it('returns complete response as JSON', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(statusCode).toBe(200);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('openai/gpt-4o');
    expect(body.id).toMatch(/^chatcmpl-/);
  });

  it('concatenates all text chunks into message content', async () => {
    const { body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('Hello world');
    expect(body.choices[0].finish_reason).toBe('stop');
  });

  it('includes usage field (zeros for now)', async () => {
    const { body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(body.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('stream: false behaves same as omitting stream', async () => {
    const { body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    });

    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hello world');
  });
});

describe('POST /v1/chat/completions — error cases', () => {
  it('returns 400 for missing model', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(statusCode).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('model');
  });

  it('returns 400 for missing messages', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
    });

    expect(statusCode).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('messages');
  });

  it('returns 400 for empty messages array', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [],
    });

    expect(statusCode).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('returns error in OpenAI format for chat exceptions (non-streaming)', async () => {
    mockChatConfig = { chunks: [], chunkDelayMs: 0, throwError: 'Provider unavailable' };

    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'bad/model',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(statusCode).toBe(500);
    expect(body.error.type).toBe('server_error');
    expect(body.error.message).toBe('Provider unavailable');
  });

  it('returns error in SSE for chat exceptions (streaming)', async () => {
    mockChatConfig = { chunks: [], chunkDelayMs: 0, throwError: 'Provider unavailable' };

    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'bad/model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const errorEvent = events.find(e => e.error);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toBe('Provider unavailable');
  });
});

describe('POST /v1/chat/completions — tool calls', () => {
  it('streams tool calls in OpenAI tool_calls format', async () => {
    mockChatConfig = {
      chunks: [
        { type: 'tool', name: 'search', state: 'running', call: { params: { q: 'test' }, result: undefined }, done: false },
        { type: 'tool', name: 'search', state: 'completed', call: { params: { q: 'test' }, result: 'found' }, done: true },
        { type: 'done', finishReason: 'tool-calls' },
      ],
      chunkDelayMs: 0,
    };

    const { events } = await postSSE(`${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Search for test' }],
      stream: true,
    });

    const toolChunks = events.filter(e => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].choices[0].delta.tool_calls[0].function.name).toBe('search');
    expect(toolChunks[0].choices[0].delta.tool_calls[0].function.arguments).toBe('{"q":"test"}');

    const doneChunk = events.find(e => e.choices?.[0]?.finish_reason === 'tool_calls');
    expect(doneChunk).toBeDefined();
  });
});

describe('POST /v1/chat/completions — request params', () => {
  it('accepts temperature, top_p, max_tokens without error', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 100,
    });

    expect(statusCode).toBe(200);
    expect(body.choices[0].message.content).toBe('Hello world');
  });

  it('accepts max_completion_tokens as alias for max_tokens', async () => {
    const { statusCode } = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      max_completion_tokens: 200,
    });

    expect(statusCode).toBe(200);
  });
});
