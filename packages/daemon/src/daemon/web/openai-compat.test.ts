/**
 * OpenAI-compatible API format translation tests
 *
 * Tests the pure mapping functions in isolation (no HTTP server):
 * model mapping, finish reason mapping, stream chunk building,
 * and complete response building.
 */

import { describe, it, expect } from 'vitest';
import {
  mapModelToOpenAI,
  mapFinishReason,
  buildStreamChunk,
  buildCompleteResponse,
  generateChatId,
  type StreamChunkOptions,
} from './openai-compat.js';
import type { ModelInfo } from '../../core/state.js';
import type { ChatChunk } from '../../core/engines.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- test assertions need flexible access to untyped response shapes */

// ── mapModelToOpenAI ────────────────────────────────────────────────────

describe('mapModelToOpenAI', () => {
  const model: ModelInfo = {
    id: 'openai/gpt-4o',
    name: 'gpt-4o',
    engineModelId: 'gpt-4o',
    provider: 'openai',
    engine: 'openai',
    contextWindow: 128000,
    capabilities: { supportsTools: true, supportsVision: true },
  };

  it('maps id from Abbenay composite ID', () => {
    const result = mapModelToOpenAI(model);
    expect(result.id).toBe('openai/gpt-4o');
  });

  it('sets object to "model"', () => {
    expect(mapModelToOpenAI(model).object).toBe('model');
  });

  it('sets owned_by from engine', () => {
    expect(mapModelToOpenAI(model).owned_by).toBe('openai');
  });

  it('sets created to 0 (unknown)', () => {
    expect(mapModelToOpenAI(model).created).toBe(0);
  });

  it('maps different engines correctly', () => {
    const anthropicModel: ModelInfo = {
      id: 'my-anthropic/claude-3-5-sonnet',
      name: 'claude-3-5-sonnet',
      engineModelId: 'claude-3-5-sonnet-20241022',
      provider: 'my-anthropic',
      engine: 'anthropic',
      contextWindow: 200000,
    };
    const result = mapModelToOpenAI(anthropicModel);
    expect(result.id).toBe('my-anthropic/claude-3-5-sonnet');
    expect(result.owned_by).toBe('anthropic');
  });
});

// ── mapFinishReason ─────────────────────────────────────────────────────

describe('mapFinishReason', () => {
  it('maps stop -> stop', () => {
    expect(mapFinishReason('stop')).toBe('stop');
  });

  it('maps length -> length', () => {
    expect(mapFinishReason('length')).toBe('length');
  });

  it('maps tool-calls -> tool_calls', () => {
    expect(mapFinishReason('tool-calls')).toBe('tool_calls');
  });

  it('maps unknown reasons to stop', () => {
    expect(mapFinishReason('other')).toBe('stop');
    expect(mapFinishReason('')).toBe('stop');
    expect(mapFinishReason('content-filter')).toBe('stop');
  });
});

// ── generateChatId ──────────────────────────────────────────────────────

describe('generateChatId', () => {
  it('starts with chatcmpl- prefix', () => {
    expect(generateChatId()).toMatch(/^chatcmpl-/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateChatId()));
    expect(ids.size).toBe(10);
  });
});

// ── buildStreamChunk ────────────────────────────────────────────────────

describe('buildStreamChunk', () => {
  const opts: StreamChunkOptions = {
    id: 'chatcmpl-test123',
    model: 'openai/gpt-4o',
    created: 1710000000,
  };

  describe('text chunks', () => {
    it('maps text chunk to delta with content', () => {
      const chunk: ChatChunk = { type: 'text', text: 'Hello' };
      const result = buildStreamChunk(chunk, opts, 0, false) as any;

      expect(result.id).toBe('chatcmpl-test123');
      expect(result.object).toBe('chat.completion.chunk');
      expect(result.model).toBe('openai/gpt-4o');
      expect(result.choices[0].delta.content).toBe('Hello');
      expect(result.choices[0].finish_reason).toBeNull();
    });

    it('includes role on first chunk', () => {
      const chunk: ChatChunk = { type: 'text', text: 'Hi' };
      const result = buildStreamChunk(chunk, opts, 0, true) as any;

      expect(result.choices[0].delta.role).toBe('assistant');
      expect(result.choices[0].delta.content).toBe('Hi');
    });

    it('omits role on subsequent chunks', () => {
      const chunk: ChatChunk = { type: 'text', text: 'world' };
      const result = buildStreamChunk(chunk, opts, 0, false) as any;

      expect(result.choices[0].delta.role).toBeUndefined();
    });
  });

  describe('tool call chunks', () => {
    it('maps running tool chunk to tool_calls delta', () => {
      const chunk: ChatChunk = {
        type: 'tool',
        name: 'search',
        state: 'running',
        call: { params: { q: 'test' }, result: undefined },
        done: false,
      };
      const result = buildStreamChunk(chunk, opts, 0, false) as any;

      expect(result.choices[0].delta.tool_calls).toHaveLength(1);
      expect(result.choices[0].delta.tool_calls[0].index).toBe(0);
      expect(result.choices[0].delta.tool_calls[0].type).toBe('function');
      expect(result.choices[0].delta.tool_calls[0].function.name).toBe('search');
      expect(result.choices[0].delta.tool_calls[0].function.arguments).toBe('{"q":"test"}');
    });

    it('returns null for completed tool chunks (results)', () => {
      const chunk: ChatChunk = {
        type: 'tool',
        name: 'search',
        state: 'completed',
        call: { params: { q: 'test' }, result: 'found it' },
        done: true,
      };
      expect(buildStreamChunk(chunk, opts, 0, false)).toBeNull();
    });
  });

  describe('done chunks', () => {
    it('maps done chunk with empty delta and finish_reason', () => {
      const chunk: ChatChunk = { type: 'done', finishReason: 'stop' };
      const result = buildStreamChunk(chunk, opts, 0, false) as any;

      expect(result.choices[0].delta).toEqual({});
      expect(result.choices[0].finish_reason).toBe('stop');
    });

    it('maps tool-calls finish reason', () => {
      const chunk: ChatChunk = { type: 'done', finishReason: 'tool-calls' };
      const result = buildStreamChunk(chunk, opts, 0, false) as any;

      expect(result.choices[0].finish_reason).toBe('tool_calls');
    });
  });

  describe('non-mapped chunks', () => {
    it('returns null for error chunks', () => {
      const chunk: ChatChunk = { type: 'error', error: 'boom' };
      expect(buildStreamChunk(chunk, opts, 0, false)).toBeNull();
    });

    it('returns null for approval_request chunks', () => {
      const chunk: ChatChunk = { type: 'approval_request', requestId: 'r1', toolName: 'x', args: {} };
      expect(buildStreamChunk(chunk, opts, 0, false)).toBeNull();
    });
  });
});

// ── buildCompleteResponse ───────────────────────────────────────────────

describe('buildCompleteResponse', () => {
  it('builds a valid non-streaming response', () => {
    const result = buildCompleteResponse(
      'chatcmpl-abc',
      'openai/gpt-4o',
      1710000000,
      'Hello world',
      'stop',
    ) as any;

    expect(result.id).toBe('chatcmpl-abc');
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('openai/gpt-4o');
    expect(result.created).toBe(1710000000);
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].index).toBe(0);
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].message.content).toBe('Hello world');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('includes usage with zeros', () => {
    const result = buildCompleteResponse('id', 'model', 0, '', 'stop') as any;
    expect(result.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('maps finish reason correctly', () => {
    const result = buildCompleteResponse('id', 'model', 0, '', 'length') as any;
    expect(result.choices[0].finish_reason).toBe('length');
  });
});
