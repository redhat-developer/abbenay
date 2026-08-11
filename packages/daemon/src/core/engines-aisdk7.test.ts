/**
 * AI SDK 7 contract tests (DR-042).
 *
 * Covers timeout mapping helpers and a real streamChat path against the
 * built-in mock engine so stream part shapes stay covered (most other tests
 * mock streamChat itself). Also verifies streamText call-site wiring via a
 * mocked `ai` module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamTextMock = vi.hoisted(() =>
  vi.fn(() => ({
    stream: (async function* () {
      yield { type: 'text-delta', text: 'hi' };
      yield { type: 'finish', finishReason: 'stop' };
    })(),
  })),
);

const isStepCountMock = vi.hoisted(() => vi.fn((n: number) => () => n <= 1));
const toolMock = vi.hoisted(() => vi.fn((def: unknown) => def));
const jsonSchemaMock = vi.hoisted(() => vi.fn((s: unknown) => s));
const outputJsonMock = vi.hoisted(() => vi.fn(() => ({ name: 'json' })));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: streamTextMock,
    isStepCount: isStepCountMock,
    tool: toolMock,
    jsonSchema: jsonSchemaMock,
    Output: { ...actual.Output, json: outputJsonMock },
  };
});

import { streamChat, toSdkTimeout, getEngine, splitSystemMessages } from './engines.js';

describe('toSdkTimeout', () => {
  it('maps flat ms to totalMs only (no step/tool halves)', () => {
    expect(toSdkTimeout(30000)).toEqual({ totalMs: 30000 });
  });

  it('returns undefined for missing or non-positive values', () => {
    expect(toSdkTimeout(undefined)).toBeUndefined();
    expect(toSdkTimeout(0)).toBeUndefined();
    expect(toSdkTimeout(-1)).toBeUndefined();
  });
});

describe('streamChat mock engine (stream contract)', () => {
  it('yields text and done from mock engine without AI SDK network', async () => {
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of streamChat(
      'mock',
      'echo',
      [{ role: 'user', content: 'hello' }],
    )) {
      chunks.push({ type: chunk.type });
    }
    expect(chunks.some((c) => c.type === 'text')).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe('done');
  });
});

describe('splitSystemMessages', () => {
  it('moves system roles into instructions and leaves other roles', () => {
    const result = splitSystemMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Be brief.' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(result.instructions).toBe('You are helpful.\n\nBe brief.');
    expect(result.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('omits instructions when there are no system messages', () => {
    const result = splitSystemMessages([{ role: 'user', content: 'hi' }]);
    expect(result.instructions).toBeUndefined();
    expect(result.messages).toHaveLength(1);
  });
});

describe('streamText AI SDK 7 wiring', () => {
  beforeEach(() => {
    streamTextMock.mockClear();
    isStepCountMock.mockClear();
    toolMock.mockClear();
    jsonSchemaMock.mockClear();
    outputJsonMock.mockClear();
  });

  it('passes system messages via instructions, not messages', async () => {
    const openai = getEngine('openai');
    expect(openai).toBeDefined();
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream(),
      }),
    })) as typeof originalCreate;

    try {
      for await (const _chunk of streamChat(
        'openai',
        'gpt-test',
        [
          { role: 'system', content: 'System prompt from Open WebUI' },
          { role: 'user', content: 'hi' },
        ],
        'sk-test',
      )) {
        // drain
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    expect(streamTextMock).toHaveBeenCalled();
    const callArg = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.instructions).toBe('System prompt from Open WebUI');
    const msgs = callArg.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.every((m) => m.role !== 'system')).toBe(true);
    expect(msgs.some((m) => m.role === 'user')).toBe(true);
  });

  it('forwards toolChoice to streamText when tools are present', async () => {
    const openai = getEngine('openai');
    expect(openai).toBeDefined();
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream(),
      }),
    })) as typeof originalCreate;

    try {
      for await (const _chunk of streamChat(
        'openai',
        'gpt-test',
        [{ role: 'user', content: 'hi' }],
        'sk-test',
        undefined,
        undefined,
        [{ name: 'web_search', description: 'search', inputSchema: '{"type":"object","properties":{}}' }],
        undefined,
        undefined,
        1,
        false,
        'required',
      )) {
        // drain
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    const callArg = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.toolChoice).toBe('required');
  });

  it('passes isStepCount, stream, maxOutputTokens, nested timeout, reasoning, and toolApproval', async () => {
    const openai = getEngine('openai');
    expect(openai).toBeDefined();

    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream(),
      }),
    })) as typeof originalCreate;

    const validator = vi.fn(async () => 'allow' as const);
    const executor = vi.fn(async () => ({ ok: true }));

    const out: string[] = [];
    try {
      for await (const chunk of streamChat(
        'openai',
        'gpt-test',
        [{ role: 'user', content: 'hi' }],
        'sk-test',
        undefined,
        { maxTokens: 128, timeout: 10000, reasoning: 'low' },
        [{ name: 'echo', description: 'echo', inputSchema: '{"type":"object","properties":{}}' }],
        executor,
        validator,
        3,
        true,
      )) {
        if (chunk.type === 'text' && chunk.text) out.push(chunk.text);
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    expect(streamTextMock).toHaveBeenCalled();
    const callArg = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.maxOutputTokens).toBe(128);
    expect(callArg.timeout).toEqual({ totalMs: 10000 });
    expect(callArg.reasoning).toBe('low');
    expect(callArg.telemetry).toEqual({
      functionId: 'abbenay.streamChat',
      recordInputs: false,
      recordOutputs: false,
    });
    expect(callArg.toolApproval).toEqual(expect.any(Function));
    expect(callArg.stopWhen).toBeDefined();
    expect(isStepCountMock).toHaveBeenCalledWith(3);
    expect(outputJsonMock).toHaveBeenCalled();
    expect(out.join('')).toContain('hi');

    const approval = callArg.toolApproval as (opts: {
      toolCall: { toolName: string; input: unknown };
    }) => Promise<string | { type: string; reason?: string }>;
    await expect(approval({ toolCall: { toolName: 'echo', input: {} } })).resolves.toBe('approved');
    expect(validator).toHaveBeenCalledWith('echo', {});

    validator.mockResolvedValueOnce('deny');
    await expect(approval({ toolCall: { toolName: 'echo', input: { x: 1 } } })).resolves.toEqual({
      type: 'denied',
      reason: 'Tool execution denied by policy',
    });

    validator.mockResolvedValueOnce('abort');
    await expect(approval({ toolCall: { toolName: 'echo', input: {} } })).rejects.toThrow(
      'Tool execution aborted by policy',
    );
  });
});

describe('streamChat error and passthrough paths', () => {
  beforeEach(() => {
    streamTextMock.mockClear();
  });

  it('yields error for unknown engine id', async () => {
    const chunks = [];
    for await (const chunk of streamChat('unknown-engine-xyz', 'model', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'error', error: 'Unknown engine: unknown-engine-xyz' },
      { type: 'done', finishReason: 'error' },
    ]);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('registers passthrough tools without executor and caps steps at 1', async () => {
    const openai = getEngine('openai');
    expect(openai).toBeDefined();
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({ stream: new ReadableStream() }),
    })) as typeof originalCreate;

    try {
      for await (const _chunk of streamChat(
        'openai',
        'gpt-test',
        [{ role: 'user', content: 'hi' }],
        'sk-test',
        undefined,
        undefined,
        [{ name: 'search', description: 'search', inputSchema: 'not-json' }],
        undefined,
        undefined,
        5,
      )) {
        // drain
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    const callArg = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const tools = callArg.tools as Record<string, { execute?: unknown }>;
    expect(tools.search).toBeDefined();
    expect(tools.search.execute).toBeUndefined();
    expect(isStepCountMock).toHaveBeenCalledWith(1);
  });

  it('maps assistant tool_calls and tool-role messages for AI SDK', async () => {
    streamTextMock.mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    });

    const openai = getEngine('openai');
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({ stream: new ReadableStream() }),
    })) as typeof originalCreate;

    try {
      for await (const _chunk of streamChat(
        'openai',
        'gpt-test',
        [
          { role: 'assistant', content: '', tool_calls: [{
            id: 'call_1',
            name: 'search',
            arguments: { q: 'abbenay' },
          }] },
          { role: 'tool', name: 'search', tool_call_id: 'call_1', content: 'result text' },
          { role: 'custom', content: 'fallback user text' },
        ],
        'sk-test',
      )) {
        // drain
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    const callArg = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const msgs = callArg.messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'search',
        input: { q: 'abbenay' },
      },
    ]);
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'search',
      output: { type: 'text', value: 'result text' },
    }]);
    expect(msgs.some((m) => m.role === 'user' && m.content === 'fallback user text')).toBe(true);
  });

  it('skips malformed tool calls and preserves OpenAI nested function shape', async () => {
    streamTextMock.mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    });

    const openai = getEngine('openai');
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({ stream: new ReadableStream() }),
    })) as typeof originalCreate;

    try {
      for await (const _chunk of streamChat(
        'openai',
        'gpt-test',
        [
          { role: 'assistant', content: '', tool_calls: [
            { id: '', name: 'skip-me', arguments: {} },
            {
              id: 'call_openai',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"docs"}' },
            },
          ] },
          { role: 'assistant', content: 'plain fallback' },
        ],
        'sk-test',
      )) {
        // drain
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    const msgs = streamTextMock.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    const withToolCall = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.content));
    expect(withToolCall?.content).toEqual([{
      type: 'tool-call',
      toolCallId: 'call_openai',
      toolName: 'search',
      input: { q: 'docs' },
    }]);
    const plainAssistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Array<{ text?: string }>).some((p) => p.text === 'plain fallback'));
    expect(plainAssistant).toBeDefined();
  });

  it('forwards stream tool, error, and denied parts to chat chunks', async () => {
    streamTextMock.mockReturnValueOnce({
      stream: (async function* () {
        yield { type: 'text-delta', text: 'partial ' };
        yield { type: 'tool-call', toolCallId: 'call_9', toolName: 'search', input: { q: 'x' } };
        yield { type: 'tool-result', toolCallId: 'call_9', toolName: 'search', input: { q: 'x' }, output: { ok: true } };
        yield { type: 'tool-output-denied', toolCallId: 'call_10' };
        yield { type: 'error', error: new Error('provider blew up') };
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    });

    const openai = getEngine('openai');
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => ({
      modelId: 'gpt-test',
      provider: 'openai',
      specificationVersion: 'v3',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => ({ stream: new ReadableStream() }),
    })) as typeof originalCreate;

    const chunks = [];
    try {
      for await (const chunk of streamChat(
        'openai',
        'gpt-test',
        [{ role: 'user', content: 'hi' }],
        'sk-test',
        undefined,
        undefined,
        [{ name: 'search', description: 'search', inputSchema: '{"type":"object","properties":{}}' }],
        async () => ({ ok: true }),
      )) {
        chunks.push(chunk);
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'text', text: 'partial ' },
      expect.objectContaining({ type: 'tool', name: 'search', state: 'running', done: false }),
      expect.objectContaining({ type: 'tool', name: 'search', state: 'completed', done: true }),
      expect.objectContaining({
        type: 'tool',
        name: 'unknown',
        state: 'completed',
        call: { params: undefined, result: { error: 'Tool execution denied by policy' } },
        done: true,
      }),
      { type: 'error', error: 'provider blew up' },
      { type: 'done', finishReason: 'stop' },
    ]));
  });

  it('wraps createModel failures as chat errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openai = getEngine('openai');
    const originalCreate = openai!.createModel;
    openai!.createModel = vi.fn(async () => {
      throw new Error('model init failed');
    }) as typeof originalCreate;

    const chunks = [];
    try {
      for await (const chunk of streamChat(
        'openai',
        'gpt-test',
        [{ role: 'user', content: 'hi' }],
        'sk-test',
      )) {
        chunks.push(chunk);
      }
    } finally {
      openai!.createModel = originalCreate;
    }

    expect(chunks).toEqual([
      { type: 'error', error: 'openai/gpt-test: model init failed' },
      { type: 'done', finishReason: 'error' },
    ]);
    expect(errSpy).toHaveBeenCalled();
  });
});
