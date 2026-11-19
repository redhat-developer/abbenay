import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const createInterfaceMock = vi.hoisted(() => vi.fn());

vi.mock('node:readline', () => ({
  createInterface: createInterfaceMock,
}));

import { runInteractiveChat } from './chat.js';
import type { DaemonState } from './state.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('runInteractiveChat JSON mode', () => {
  it('forwards a resumed session ID to the provider chat call', async () => {
    createInterfaceMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield 'continue the conversation';
      },
    });

    const chat = vi.fn(async function* () {});
    const state = {
      initMcpConnections: vi.fn(),
      sessionStore: {
        getOwned: vi.fn(async () => ({ id: 'saved-session-123', model: 'opencode/kimi-k3' })),
        get: vi.fn(async () => ({ messages: [{ role: 'user', content: 'previous turn' }] })),
      },
      chat,
    } as unknown as DaemonState;

    await runInteractiveChat({ session: 'resume-me', json: true, state });

    expect(chat).toHaveBeenCalledWith(
      'opencode/kimi-k3',
      expect.arrayContaining([
        { role: 'user', content: 'previous turn' },
        { role: 'user', content: 'continue the conversation' },
      ]),
      undefined,
      expect.objectContaining({
        sessionId: 'saved-session-123',
        providerSessionId: 'saved-session-123',
      }),
    );
  });

  it('reuses one provider session ID across interactive turns', async () => {
    const rl = Object.assign(new EventEmitter(), {
      prompt: vi.fn(),
      close: vi.fn(),
    });
    let promptCount = 0;
    rl.prompt.mockImplementation(() => {
      const currentPrompt = promptCount++;
      queueMicrotask(() => {
        if (currentPrompt < 2) {
          rl.emit('line', `message ${currentPrompt + 1}`);
        } else {
          rl.emit('close');
        }
      });
    });
    createInterfaceMock.mockReturnValue(rl);

    const chat = vi.fn(async function* () {
      yield { type: 'done', finishReason: 'stop' };
    });
    const state = {
      initMcpConnections: vi.fn(),
      chat,
    } as unknown as DaemonState;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runInteractiveChat({ model: 'opencode/kimi-k3', state });
    } finally {
      errorSpy.mockRestore();
    }

    expect(chat).toHaveBeenCalledTimes(2);
    const providerSessionIds = chat.mock.calls.map((call) => call[3]?.providerSessionId);
    expect(providerSessionIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(providerSessionIds[1]).toBe(providerSessionIds[0]);
  });
});
