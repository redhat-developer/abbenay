import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  parseModelPickerInput,
  promptModelPicker,
  type PickerModel,
} from './chat.js';

// ── parseModelPickerInput ─────────────────────────────────────────────

describe('parseModelPickerInput', () => {
  it('empty input selects default (1)', () => {
    expect(parseModelPickerInput('', 3)).toBe(1);
    expect(parseModelPickerInput('  ', 3)).toBe(1);
  });

  it('valid number in range', () => {
    expect(parseModelPickerInput('2', 3)).toBe(2);
    expect(parseModelPickerInput(' 3 ', 3)).toBe(3);
  });

  it('out of range returns null', () => {
    expect(parseModelPickerInput('0', 3)).toBeNull();
    expect(parseModelPickerInput('4', 3)).toBeNull();
    expect(parseModelPickerInput('-1', 3)).toBeNull();
  });

  it('non-numeric returns null', () => {
    expect(parseModelPickerInput('abc', 3)).toBeNull();
    expect(parseModelPickerInput('1.5', 3)).toBeNull();
  });

  it('single model — only 1 is valid', () => {
    expect(parseModelPickerInput('1', 1)).toBe(1);
    expect(parseModelPickerInput('', 1)).toBe(1);
    expect(parseModelPickerInput('2', 1)).toBeNull();
  });
});

// ── promptModelPicker ─────────────────────────────────────────────────

function makeModels(...ids: string[]): PickerModel[] {
  return ids.map((id) => {
    const [provider, ...rest] = id.split('/');
    return { id, name: rest.join('/'), provider };
  });
}

function fakeRl(): EventEmitter & { once: ReturnType<typeof vi.fn> } {
  return new EventEmitter() as EventEmitter & { once: ReturnType<typeof vi.fn> };
}

describe('promptModelPicker', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  it('selects model by number', async () => {
    const rl = fakeRl();
    const models = makeModels('openai/gpt-4o', 'anthropic/claude-sonnet');
    const promise = promptModelPicker(models, rl as never);

    rl.emit('line', '2');
    const result = await promise;
    expect(result).toBe('anthropic/claude-sonnet');
  });

  it('selects default on empty input', async () => {
    const rl = fakeRl();
    const models = makeModels('openai/gpt-4o', 'anthropic/claude-sonnet');
    const promise = promptModelPicker(models, rl as never);

    rl.emit('line', '');
    const result = await promise;
    expect(result).toBe('openai/gpt-4o');
  });

  it('re-prompts on invalid input then accepts valid', async () => {
    const rl = fakeRl();
    const models = makeModels('openai/gpt-4o', 'anthropic/claude-sonnet');
    const promise = promptModelPicker(models, rl as never);

    rl.emit('line', '9');
    // After invalid input, it re-registers a handler
    await new Promise((r) => setTimeout(r, 10));
    rl.emit('line', '1');
    const result = await promise;
    expect(result).toBe('openai/gpt-4o');
  });

  it('returns null on close (cancellation)', async () => {
    const rl = fakeRl();
    const models = makeModels('openai/gpt-4o');
    const promise = promptModelPicker(models, rl as never);

    rl.emit('close');
    const result = await promise;
    expect(result).toBeNull();
  });

  it('displays all model IDs in picker output', async () => {
    const rl = fakeRl();
    const models = makeModels('openai/gpt-4o', 'anthropic/claude-sonnet', 'ollama/llama3');
    const promise = promptModelPicker(models, rl as never);

    rl.emit('line', '');
    await promise;

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('openai/gpt-4o');
    expect(output).toContain('anthropic/claude-sonnet');
    expect(output).toContain('ollama/llama3');
    expect(output).toContain('(default)');
  });

  it('single model — Enter selects it', async () => {
    const rl = fakeRl();
    const models = makeModels('mock/echo');
    const promise = promptModelPicker(models, rl as never);

    rl.emit('line', '');
    const result = await promise;
    expect(result).toBe('mock/echo');
  });
});

