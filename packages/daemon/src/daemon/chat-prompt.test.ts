/**
 * chat.ts unit tests
 *
 * - parseApprovalInput
 * - runInteractiveChat (interactive + json modes)
 * - model picker helpers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseApprovalInput, runInteractiveChat, parseModelPickerInput, promptModelPicker } from './chat.js';
import type { DaemonState } from './state.js';

let mockRl: EventEmitter & {
  prompt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
};

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

vi.mock('./daemon.js', () => ({
  startDaemon: vi.fn(),
}));

vi.mock('./transport.js', () => ({
  isDaemonRunningSync: vi.fn(() => true),
}));

describe('parseApprovalInput', () => {
  describe('allow once', () => {
    it.each(['a', 'allow', 'y', 'yes'])('"%s" -> allow', (input) => {
      expect(parseApprovalInput(input)).toBe('allow');
    });

    it('handles whitespace', () => {
      expect(parseApprovalInput('  a  ')).toBe('allow');
      expect(parseApprovalInput('\ty\n')).toBe('allow');
    });
  });

  describe('allow always (case-sensitive)', () => {
    it('"A" (uppercase) -> allow-always', () => {
      expect(parseApprovalInput('A')).toBe('allow-always');
    });

    it('"always" -> allow-always', () => {
      expect(parseApprovalInput('always')).toBe('allow-always');
    });

    it('"ALWAYS" -> allow-always', () => {
      expect(parseApprovalInput('ALWAYS')).toBe('allow-always');
    });

    it('"Always" -> allow-always', () => {
      expect(parseApprovalInput('Always')).toBe('allow-always');
    });

    it('"A" is NOT "allow" — this was a real bug', () => {
      const decision = parseApprovalInput('A');
      expect(decision).not.toBe('allow');
      expect(decision).toBe('allow-always');
    });
  });

  describe('deny', () => {
    it.each(['d', 'deny', 'n', 'no'])('"%s" -> deny', (input) => {
      expect(parseApprovalInput(input)).toBe('deny');
    });
  });

  describe('abort', () => {
    it.each(['b', 'abort'])('"%s" -> abort', (input) => {
      expect(parseApprovalInput(input)).toBe('abort');
    });
  });

  describe('invalid input', () => {
    it.each(['', 'x', 'maybe', '123', 'allowalways'])('"%s" -> null (re-prompt)', (input) => {
      expect(parseApprovalInput(input)).toBeNull();
    });

    it('whitespace-only -> null', () => {
      expect(parseApprovalInput('   ')).toBeNull();
    });
  });

  describe('case insensitivity for non-A inputs', () => {
    it.each(['ALLOW', 'Allow', 'YES', 'Yes'])('"%s" -> allow', (input) => {
      expect(parseApprovalInput(input)).toBe('allow');
    });

    it.each(['DENY', 'Deny', 'NO', 'No'])('"%s" -> deny', (input) => {
      expect(parseApprovalInput(input)).toBe('deny');
    });

    it.each(['ABORT', 'Abort', 'B'])('"%s" -> abort', (input) => {
      expect(parseApprovalInput(input)).toBe('abort');
    });
  });
});

describe('runInteractiveChat', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockRl = new EventEmitter() as typeof mockRl;
    mockRl.prompt = vi.fn();
    mockRl.close = vi.fn();
    mockRl.once = vi.fn((event: string, handler: () => void) => {
      mockRl.on(event, handler);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  function mockState(overrides: Partial<DaemonState> = {}): DaemonState {
    return {
      initMcpConnections: vi.fn().mockResolvedValue(undefined),
      sessionStore: {
        create: vi.fn().mockResolvedValue({ id: 'sess-1' }),
        getOwned: vi.fn().mockResolvedValue({ id: 'sess-1', model: 'mock/echo', messages: [] }),
        get: vi.fn().mockResolvedValue({ id: 'sess-1', messages: [{ role: 'user', content: 'prior' }] }),
        appendMessage: vi.fn().mockResolvedValue(undefined),
        updateTitle: vi.fn().mockResolvedValue(undefined),
      },
      chat: vi.fn().mockImplementation(async function* () {
        yield { type: 'text', text: 'hello' };
      }),
      ...overrides,
    } as unknown as DaemonState;
  }

  it('json mode streams chat chunks to stdout', async () => {
    mockRl[Symbol.asyncIterator] = async function* () {
      yield 'hello from stdin';
    };

    const chat = vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'response' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const state = mockState({ chat });
    await runInteractiveChat({ state, model: 'mock/echo', json: true });

    expect(chat).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('response');
  });

  it('uses pre-initialized state and exits on close', async () => {
    const state = mockState();
    const promise = runInteractiveChat({ state, model: 'mock/echo' });
    setImmediate(() => mockRl.emit('close'));
    await promise;
    expect(state.initMcpConnections).toHaveBeenCalled();
  });

  it('requires model when session new without model', async () => {
    const state = mockState();
    await expect(runInteractiveChat({ state, session: 'new' })).rejects.toThrow('process.exit:1');
  });

  it('creates new session then exits', async () => {
    const state = mockState();
    const promise = runInteractiveChat({ state, session: 'new', model: 'mock/echo' });
    setImmediate(() => mockRl.emit('close'));
    await promise;
    expect(state.sessionStore.create).toHaveBeenCalled();
  });

  it('exits when session not found', async () => {
    const state = mockState();
    vi.mocked(state.sessionStore.getOwned).mockRejectedValue(new Error('missing'));
    await expect(runInteractiveChat({ state, session: 'bad' })).rejects.toThrow('process.exit:1');
  });

  it('json mode returns early on empty stdin', async () => {
    const state = mockState();
    mockRl[Symbol.asyncIterator] = async function* () {};
    await runInteractiveChat({ state, model: 'mock/echo', json: true });
    expect(state.chat).not.toHaveBeenCalled();
  });

  it('promptModelPicker resolves default choice', async () => {
    const rl = new EventEmitter() as EventEmitter & { once: typeof mockRl.once };
    rl.once = vi.fn((event: string, handler: (line: string) => void) => {
      rl.on(event, handler);
    });
    const models = [{ id: 'a', name: 'a', provider: 'mock' }];
    const pickPromise = promptModelPicker(models, rl as never);
    setImmediate(() => rl.emit('line', ''));
    await expect(pickPromise).resolves.toBe('a');
  });

  it('parseModelPickerInput handles bounds', () => {
    expect(parseModelPickerInput('', 3)).toBe(1);
    expect(parseModelPickerInput('2', 3)).toBe(2);
    expect(parseModelPickerInput('9', 3)).toBeNull();
  });
});
