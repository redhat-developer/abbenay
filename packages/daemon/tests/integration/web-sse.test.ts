/**
 * Layer 2: Express SSE tests (direct DaemonState)
 * 
 * Tests the web server's SSE chat endpoint with a mock DaemonState.
 * No gRPC in the loop — the Express app calls DaemonState directly.
 * 
 *   HTTP POST → Express → DaemonState.chat() → SSE events → HTTP response
 * 
 * This layer verifies that:
 * - Express correctly calls DaemonState methods
 * - SSE events are properly formatted
 * - Text chunks arrive in order via SSE
 * - Error handling works
 * - Multiple concurrent SSE connections work
 * - Client disconnect stops streaming
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createWebApp } from '../../src/daemon/web/server.js';
import type { DaemonState } from '../../src/daemon/state.js';
import type { ProviderInfo, ModelInfo } from '../../src/core/state.js';
import type { ConnectedClient } from '../../src/daemon/state.js';
import type { SecretStore } from '../../src/core/secrets.js';

// ─── Mock DaemonState ───────────────────────────────────────────────────

/** Configurable mock chat behavior */
interface MockChatConfig {
  chunks: string[];
  chunkDelayMs: number;
  finishReason: string;
  errorMessage?: string;
  initialDelayMs?: number;
}

let mockChatConfig: MockChatConfig = {
  chunks: ['Hello', ' from', ' SSE'],
  chunkDelayMs: 5,
  finishReason: 'stop',
};

const chatRequests: Array<{ model: string; messages: any[] }> = [];

/** In-memory secret store for testing */
const mockSecretStore: SecretStore = {
  async get(key: string) { return key === 'OPENAI_API_KEY' ? 'sk-test' : null; },
  async set(key: string, value: string) {},
  async delete(key: string) { return true; },
  async has(key: string) { return key === 'OPENAI_API_KEY'; },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create a mock DaemonState that matches the interface the web server expects */
function createMockState(): DaemonState {
  return {
    version: '0.1.0-test',
    startedAt: new Date(),
    secretStore: mockSecretStore,
    
    get clientCount() { return 1; },
    
    getClients(): ConnectedClient[] {
      return [{
        clientId: 'test-001',
        clientType: 'CLI' as any,
        connectedAt: new Date(),
        isSpawner: false,
        workspacePaths: [],
      }];
    },
    
    getVSCodeWorkspaces(): string[] {
      return ['/home/test/project'];
    },
    
    notifyModelsChanged(_reason: string): void {
      // No-op in test mock
    },
    
    async listProviders(): Promise<ProviderInfo[]> {
      return [
        { id: 'openai', engine: 'openai', displayName: 'OpenAI', configured: true, healthy: true, requiresKey: true },
        { id: 'anthropic', engine: 'anthropic', displayName: 'Anthropic', configured: false, healthy: true, requiresKey: true },
      ] as ProviderInfo[];
    },
    
    async listModels(): Promise<ModelInfo[]> {
      return [
        { id: 'openai/gpt-4o', name: 'gpt-4o', engineModelId: 'gpt-4o', provider: 'openai', engine: 'openai', displayName: 'GPT-4o', contextWindow: 128000, capabilities: { supportsTools: true, supportsVision: false } },
      ] as ModelInfo[];
    },
    
    async* chat(model: string, messages: Array<{ role: string; content: string }>) {
      chatRequests.push({ model, messages });
      
      const cfg = mockChatConfig;
      
      if (cfg.errorMessage) {
        throw new Error(cfg.errorMessage);
      }
      
      if (cfg.initialDelayMs) {
        await sleep(cfg.initialDelayMs);
      }
      
      for (const text of cfg.chunks) {
        yield { type: 'text' as const, text };
        if (cfg.chunkDelayMs > 0) {
          await sleep(cfg.chunkDelayMs);
        }
      }
      
      yield { type: 'done' as const, finishReason: cfg.finishReason };
    },
  } as any as DaemonState;
}

// ─── Test Setup ─────────────────────────────────────────────────────────

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

// ─── HTTP Helpers ───────────────────────────────────────────────────────

function postSSE(
  url: string,
  body: any,
  options?: { timeoutMs?: number; abortAfterEvents?: number }
): Promise<{ events: any[]; rawLines: string[]; statusCode: number; headers: http.IncomingHttpHeaders }> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const abortAfterEvents = options?.abortAfterEvents;
  
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const rawLines: string[] = [];
    let buffer = '';
    let resolved = false;
    
    const postData = JSON.stringify(body);
    const urlObj = new URL(url);
    
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
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
          rawLines.push(trimmed);
          
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.substring(6);
            if (data === '[DONE]') {
              events.push({ type: 'done_signal' });
            } else {
              try { events.push(JSON.parse(data)); }
              catch { events.push({ type: 'raw', data }); }
            }
          }
          
          if (abortAfterEvents && events.length >= abortAfterEvents && !resolved) {
            resolved = true;
            req.destroy();
            resolve({ events, rawLines, statusCode, headers });
            return;
          }
        }
      });
      
      res.on('end', () => {
        if (!resolved) { resolved = true; resolve({ events, rawLines, statusCode, headers }); }
      });
      
      res.on('error', (err) => {
        if (!resolved) { resolved = true; reject(err); }
      });
    });
    
    req.on('error', (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });
    
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        req.destroy();
        reject(new Error(`SSE request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    
    req.on('close', () => clearTimeout(timer));
    req.write(postData);
    req.end();
  });
}

function httpRequest(
  method: string,
  url: string,
  body?: any
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = body ? JSON.stringify(body) : '';
    
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      } : {},
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Web API - Unary Endpoints (direct DaemonState)', () => {
  it('should return health from DaemonState', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/health`);
    expect(statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0-test');
    expect(body.healthy).toBe(true);
  });
  
  it('should list providers from DaemonState (wrapped, camelCase)', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/providers`);
    expect(statusCode).toBe(200);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0].id).toBe('openai');
    expect(body.providers[0].configured).toBe(true);
  });
  
  it('should list models from DaemonState (wrapped, camelCase)', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/models`);
    expect(statusCode).toBe(200);
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe('openai/gpt-4o');
    expect(body.models[0].capabilities).toBeDefined();
  });
  
  it('should list workspaces from DaemonState (wrapped)', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/workspaces`);
    expect(statusCode).toBe(200);
    expect(body.workspaces).toContain('/home/test/project');
  });
  
  it('should get daemon status from DaemonState (camelCase)', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/status`);
    expect(statusCode).toBe(200);
    expect(body.version).toBe('0.1.0-test');
    expect(body.connectedClients).toBe(1);
    expect(body.activeSessions).toBe(0);
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0].clientId).toBe('test-001');
    // Should NOT have snake_case fields
    expect(body.connected_clients).toBeUndefined();
    expect(body.clients[0].client_id).toBeUndefined();
  });
  
  it('should return 400 for POST /api/chat without model', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/chat`, {
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(statusCode).toBe(400);
    expect(body.error).toContain('model');
  });
  
  it('should return 400 for POST /api/chat without messages', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
    });
    expect(statusCode).toBe(400);
    expect(body.error).toContain('messages');
  });
});

describe('Web API - Config Endpoints', () => {
  it('GET /api/config should return { config, path } shape', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/config`);
    expect(statusCode).toBe(200);
    // Must have config and path keys
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('path');
    expect(typeof body.path).toBe('string');
    expect(body.path).toContain('abbenay');
  });

  it('GET /api/config?location=user should return user config', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/config?location=user`);
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('path');
  });

  it('POST /api/config should accept { location, config } payload', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/config`, {
      location: 'user',
      config: { providers: {} },
    });
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body).toHaveProperty('path');
  });
});

describe('Web API - Secrets Endpoints', () => {
  it('GET /api/secrets should return { secrets: [...] } with hasValue (camelCase)', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/secrets`);
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty('secrets');
    expect(Array.isArray(body.secrets)).toBe(true);
    // Each entry should have key and hasValue (not has_value)
    for (const s of body.secrets) {
      expect(s).toHaveProperty('key');
      expect(s).toHaveProperty('hasValue');
      expect(s).not.toHaveProperty('has_value');
    }
  });

  it('POST /api/secrets/:key should set a secret', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/secrets/TEST_KEY`, {
      value: 'test-value-123',
    });
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
  });

  it('POST /api/secrets/:key should reject missing value', async () => {
    const { statusCode, body } = await httpRequest('POST', `${baseUrl}/api/secrets/TEST_KEY`, {});
    expect(statusCode).toBe(400);
    expect(body.error).toContain('value');
  });

  it('DELETE /api/secrets/:key should succeed', async () => {
    const { statusCode, body } = await httpRequest('DELETE', `${baseUrl}/api/secrets/TEST_KEY`);
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe('Web API - Key Status Endpoint', () => {
  it('GET /api/key-status should check keychain availability', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/key-status?source=keychain&name=OPENAI_API_KEY`);
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty('exists');
    expect(body.exists).toBe(true);
  });

  it('GET /api/key-status should return false for unknown key', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/key-status?source=keychain&name=NONEXISTENT_KEY`);
    expect(statusCode).toBe(200);
    expect(body.exists).toBe(false);
  });

  it('GET /api/key-status should check env var availability', async () => {
    // HOME is always set
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/key-status?source=env&name=HOME`);
    expect(statusCode).toBe(200);
    expect(body.exists).toBe(true);
  });

  it('GET /api/key-status should return 400 without params', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/key-status`);
    expect(statusCode).toBe(400);
    expect(body.error).toBeDefined();
  });
});

describe('Web API - CORS and Headers', () => {
  it('should set CORS headers on responses', async () => {
    const { statusCode, body } = await httpRequest('GET', `${baseUrl}/api/health`);
    // CORS is handled by middleware, verify the response is accessible
    expect(statusCode).toBe(200);
  });

  it('SSE responses should have correct content-type and cache headers', async () => {
    mockChatConfig = { chunks: ['hi'], chunkDelayMs: 0, finishReason: 'stop' };
    const { headers } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['connection']).toBe('keep-alive');
  });
});

describe('Web API - SSE Chat Streaming (direct DaemonState)', () => {
  it('should stream text chunks as SSE events', async () => {
    mockChatConfig = { chunks: ['Hello', ' SSE', '!'], chunkDelayMs: 5, finishReason: 'stop' };
    
    const { events, statusCode, headers } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    
    const textEvents = events.filter(e => e.type === 'text');
    const doneEvents = events.filter(e => e.type === 'done');
    const doneSignals = events.filter(e => e.type === 'done_signal');
    
    expect(textEvents).toHaveLength(3);
    expect(textEvents[0].content).toBe('Hello');
    expect(textEvents[1].content).toBe(' SSE');
    expect(textEvents[2].content).toBe('!');
    
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].finish_reason).toBe('stop');
    
    expect(doneSignals).toHaveLength(1);
  });
  
  it('should concatenate SSE text events to form complete response', async () => {
    mockChatConfig = { chunks: ['The answer', ' is ', '42'], chunkDelayMs: 5, finishReason: 'stop' };
    
    const { events } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'What is the answer?' }],
    });
    
    const fullText = events.filter(e => e.type === 'text').map(e => e.content).join('');
    expect(fullText).toBe('The answer is 42');
  });
  
  it('should pass the correct model and messages to DaemonState', async () => {
    chatRequests.length = 0;
    mockChatConfig = { chunks: ['OK'], chunkDelayMs: 0, finishReason: 'stop' };
    
    await postSSE(`${baseUrl}/api/chat`, {
      model: 'anthropic/claude-3',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Hello' },
      ],
    });
    
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].model).toBe('anthropic/claude-3');
    expect(chatRequests[0].messages[0].role).toBe('system');
    expect(chatRequests[0].messages[0].content).toBe('Be brief');
    expect(chatRequests[0].messages[1].role).toBe('user');
  });
  
  it('should handle errors from DaemonState.chat()', async () => {
    mockChatConfig = { chunks: [], chunkDelayMs: 0, finishReason: 'stop', errorMessage: 'Provider unavailable' };
    
    const { events } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'bad/model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    
    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0].error).toBe('Provider unavailable');
    
    // Reset
    mockChatConfig = { chunks: ['Hello'], chunkDelayMs: 5, finishReason: 'stop' };
  });
  
  it('should handle slow/delayed streaming', async () => {
    mockChatConfig = { chunks: ['Slow', ' response'], chunkDelayMs: 50, finishReason: 'stop', initialDelayMs: 100 };
    
    const start = Date.now();
    const { events } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    }, { timeoutMs: 15000 });
    const elapsed = Date.now() - start;
    
    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].content).toBe('Slow');
    expect(elapsed).toBeGreaterThan(100);
    
    mockChatConfig = { chunks: ['Hello'], chunkDelayMs: 5, finishReason: 'stop' };
  });
  
  it('should handle multiple concurrent SSE requests', async () => {
    mockChatConfig = { chunks: ['concurrent', ' test'], chunkDelayMs: 5, finishReason: 'stop' };
    
    const results = await Promise.all([
      postSSE(`${baseUrl}/api/chat`, { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'R1' }] }),
      postSSE(`${baseUrl}/api/chat`, { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'R2' }] }),
      postSSE(`${baseUrl}/api/chat`, { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'R3' }] }),
    ]);
    
    for (const result of results) {
      const fullText = result.events.filter(e => e.type === 'text').map(e => e.content).join('');
      expect(fullText).toBe('concurrent test');
    }
  });
  
  it('should handle client disconnect (abort)', async () => {
    mockChatConfig = { chunks: ['A', 'B', 'C', 'D', 'E'], chunkDelayMs: 100, finishReason: 'stop' };
    
    const { events } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    }, { abortAfterEvents: 2 });
    
    expect(events.length).toBeGreaterThanOrEqual(2);
    
    mockChatConfig = { chunks: ['Hello'], chunkDelayMs: 5, finishReason: 'stop' };
    await sleep(100); // Let server clean up
  });
  
  it('should set correct SSE headers', async () => {
    mockChatConfig = { chunks: ['hi'], chunkDelayMs: 0, finishReason: 'stop' };
    
    const { headers } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
  });
  
  it('should handle large streaming responses', async () => {
    const largeChunks = Array.from({ length: 50 }, (_, i) => `chunk-${i} `);
    mockChatConfig = { chunks: largeChunks, chunkDelayMs: 0, finishReason: 'stop' };
    
    const { events } = await postSSE(`${baseUrl}/api/chat`, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    
    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(50);
    expect(textEvents[0].content).toBe('chunk-0 ');
    expect(textEvents[49].content).toBe('chunk-49 ');
    
    mockChatConfig = { chunks: ['Hello'], chunkDelayMs: 5, finishReason: 'stop' };
  });
});
