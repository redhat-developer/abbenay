/**
 * Engine registry invariant tests.
 *
 * Ensures PROVIDER_LOADERS stays in sync with every @ai-sdk/* package
 * referenced in the ENGINES registry, catching drift at dev time before
 * it becomes a runtime failure in the SEA binary.
 *
 * Also covers vertex-anthropic proxy-compat helpers (body sanitization,
 * JSON→SSE conversion).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeVertexRequestBody, convertAnthropicJsonToSse, fetchModels } from './engines.js';

const ENGINES_SRC = fs.readFileSync(
  path.join(__dirname, 'engines.ts'),
  'utf-8',
);

function extractPatterns(pattern: RegExp): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(ENGINES_SRC)) !== null) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
}

describe('PROVIDER_LOADERS coverage', () => {
  it('should have a loader for every @ai-sdk/* package used in ENGINES', () => {
    const referencedPkgs = extractPatterns(
      /(?:dedicatedProvider|loadProviderFactory)\(\s*'(@ai-sdk\/[^']+)'/g,
    );
    expect(referencedPkgs.length).toBeGreaterThan(0);

    const loaderPkgs = extractPatterns(
      /^\s*'(@ai-sdk\/[^']+)':\s*\(\)\s*=>\s*import\(/gm,
    );
    expect(loaderPkgs.length).toBeGreaterThan(0);

    const loaderSet = new Set(loaderPkgs);
    const missing = referencedPkgs.filter((pkg) => !loaderSet.has(pkg));
    expect(missing, `Missing PROVIDER_LOADERS entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('should not have orphaned loader entries', () => {
    const referencedPkgs = new Set(extractPatterns(
      /(?:dedicatedProvider|loadProviderFactory)\(\s*'(@ai-sdk\/[^']+)'/g,
    ));

    const loaderPkgs = extractPatterns(
      /^\s*'(@ai-sdk\/[^']+)':\s*\(\)\s*=>\s*import\(/gm,
    );

    const orphaned = loaderPkgs.filter((pkg) => !referencedPkgs.has(pkg));
    expect(orphaned, `Orphaned PROVIDER_LOADERS entries: ${orphaned.join(', ')}`).toEqual([]);
  });
});

describe('sanitizeVertexRequestBody', () => {
  it('should strip stream_options but preserve stream field', () => {
    const input = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      anthropic_version: 'vertex-2023-10-16',
    });
    const result = sanitizeVertexRequestBody(input);
    expect(result).not.toBeNull();
    expect(result!.removed).toEqual(['stream_options']);
    const parsed = JSON.parse(result!.body);
    expect(parsed).toHaveProperty('stream', true);
    expect(parsed).not.toHaveProperty('stream_options');
    expect(parsed).toHaveProperty('messages');
    expect(parsed).toHaveProperty('anthropic_version');
  });

  it('should return null when no fields need stripping', () => {
    const input = JSON.stringify({ messages: [], anthropic_version: 'vertex-2023-10-16' });
    expect(sanitizeVertexRequestBody(input)).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    expect(sanitizeVertexRequestBody('not json')).toBeNull();
  });

  it('should return null when only stream is present (nothing to strip)', () => {
    const input = JSON.stringify({ messages: [], stream: true });
    const result = sanitizeVertexRequestBody(input);
    expect(result).toBeNull();
  });
});

describe('convertAnthropicJsonToSse', () => {
  it('should convert a text-only response to SSE events', () => {
    const json = JSON.stringify({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4@20250514',
      content: [{ type: 'text', text: 'Hello world' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('event: message_start');
    expect(result.body).toContain('event: content_block_start');
    expect(result.body).toContain('event: content_block_delta');
    expect(result.body).toContain('Hello world');
    expect(result.body).toContain('event: message_stop');
    expect(result.body.endsWith('\n')).toBe(true);
  });

  it('should convert tool_use blocks to SSE events', () => {
    const json = JSON.stringify({
      id: 'msg_456',
      content: [
        { type: 'text', text: 'Let me call a tool' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
      ],
    });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('Let me call a tool');
    expect(result.body).toContain('"type":"tool_use"');
    expect(result.body).toContain('"name":"search"');
    expect(result.body).toContain('"id":"call_1"');
    expect(result.body).toContain('input_json_delta');
    expect(result.body).toContain('event: message_stop');
  });

  it('should return parse-error reason for invalid JSON', () => {
    const result = convertAnthropicJsonToSse('{broken');
    expect(result).toEqual({ ok: false, reason: 'parse-error' });
  });

  it('should return parse-error for JSON that is not an Anthropic Messages response', () => {
    const errorPayload = JSON.stringify({ error: { type: 'server_error', message: 'Internal error' } });
    expect(convertAnthropicJsonToSse(errorPayload)).toEqual({ ok: false, reason: 'parse-error' });
    const randomObj = JSON.stringify({ status: 'ok', data: [1, 2, 3] });
    expect(convertAnthropicJsonToSse(randomObj)).toEqual({ ok: false, reason: 'parse-error' });
  });

  it('should return non-text-content reason for null content blocks', () => {
    const json = JSON.stringify({ id: 'msg', content: [null, { type: 'text', text: 'hi' }] });
    const result = convertAnthropicJsonToSse(json);
    expect(result).toEqual({ ok: false, reason: 'non-text-content' });
  });

  it('should handle empty content array', () => {
    const json = JSON.stringify({ id: 'msg', content: [] });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('event: message_start');
  });

  it('should stream multiple text blocks as separate SSE events', () => {
    const json = JSON.stringify({
      id: 'msg',
      content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
    });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('Hello ');
    expect(result.body).toContain('world');
    const blockDeltaCount = (result.body.match(/event: content_block_delta/g) || []).length;
    expect(blockDeltaCount).toBe(2);
  });

  it('should preserve message metadata in SSE events', () => {
    const json = JSON.stringify({
      id: 'msg_789',
      model: 'claude-sonnet-4@20250514',
      content: [{ type: 'text', text: 'test' }],
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const startLine = result.body.split('\n').find(l => l.startsWith('data: ') && l.includes('message_start'));
    expect(startLine).toBeDefined();
    const startData = JSON.parse(startLine!.replace('data: ', ''));
    expect(startData.message.id).toBe('msg_789');
    expect(startData.message.model).toBe('claude-sonnet-4@20250514');
    expect(startData.message.usage.input_tokens).toBe(42);
  });

  it('should propagate stop_reason from the response', () => {
    const json = JSON.stringify({
      id: 'msg_stop',
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
    });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deltaLine = result.body.split('\n').find(l => l.startsWith('data: ') && l.includes('message_delta'));
    expect(deltaLine).toBeDefined();
    const deltaData = JSON.parse(deltaLine!.replace('data: ', ''));
    expect(deltaData.delta.stop_reason).toBe('max_tokens');
    expect(deltaData.delta.stop_sequence).toBeNull();
  });

  it('should default stop_reason to end_turn when absent', () => {
    const json = JSON.stringify({
      id: 'msg_default',
      content: [{ type: 'text', text: 'done' }],
    });
    const result = convertAnthropicJsonToSse(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deltaLine = result.body.split('\n').find(l => l.startsWith('data: ') && l.includes('message_delta'));
    const deltaData = JSON.parse(deltaLine!.replace('data: ', ''));
    expect(deltaData.delta.stop_reason).toBe('end_turn');
  });
});

describe('Gemini model discovery auth (no query-string keys)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should send API key via x-goog-api-key and never put key material in the URL', async () => {
    const apiKey = 'test-gemini-secret-key-xyz';
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({
        models: [{
          name: 'models/gemini-2.0-flash',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 1048576,
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const models = await fetchModels('gemini', apiKey);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('gemini-2.0-flash');

    expect(capturedUrl).toContain('/v1beta/models');
    expect(capturedUrl).not.toContain('key=');
    expect(capturedUrl).not.toContain(apiKey);

    const headers = new Headers(capturedHeaders);
    expect(headers.get('x-goog-api-key')).toBe(apiKey);
  });

  it('should not construct Gemini URLs with query-string API keys', () => {
    // Ban executable patterns; comments documenting the ban may mention key=.
    expect(ENGINES_SRC).not.toMatch(/`\$\{[^`]*\}\?key=\$\{/);
    expect(ENGINES_SRC).not.toMatch(/['"`]\?key=\$\{/);
    expect(ENGINES_SRC).toMatch(/x-goog-api-key/);
  });
});
