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

import { streamChat, toSdkTimeout, getEngine } from './engines.js';

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
    expect(chunks.some((c) => c.type === 'text' || c.type === 'done')).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe('done');
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
