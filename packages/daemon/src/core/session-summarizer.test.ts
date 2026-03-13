/**
 * Session summarizer unit tests
 *
 * Tests generateSessionSummary and maybeSummarize with a mock CoreState
 * and real SessionStore backed by a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from './session-store.js';
import { generateSessionSummary, maybeSummarize } from './session-summarizer.js';
import type { CoreState } from './state.js';

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-summarizer-test-'));
  store = new SessionStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createMockState(responseText: string): CoreState {
  return {
    async* chat(_model: string, _messages: Array<{ role: string; content: string }>) {
      yield { type: 'text' as const, text: responseText };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
  } as unknown as CoreState;
}

function createErrorState(): CoreState {
  return {
    async *chat() {
      yield { type: 'error' as const, error: 'forced' };
      throw new Error('LLM unavailable');
    },
  } as unknown as CoreState;
}

describe('generateSessionSummary', () => {
  it('returns LLM-generated text from session messages', async () => {
    const session = await store.create('test/model', 'Test');
    await store.appendMessage(session.id, { role: 'user', content: 'Hello' });
    await store.appendMessage(session.id, { role: 'assistant', content: 'Hi there!' });

    const updated = await store.get(session.id, true);
    const state = createMockState('A greeting exchange.');

    const summary = await generateSessionSummary(state, updated);
    expect(summary).toBe('A greeting exchange.');
  });

  it('uses override model when provided', async () => {
    const session = await store.create('test/model', 'Test');
    await store.appendMessage(session.id, { role: 'user', content: 'Hello' });

    const updated = await store.get(session.id, true);
    let capturedModel = '';
    const state = {
      async* chat(model: string) {
        capturedModel = model;
        yield { type: 'text' as const, text: 'summary' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    } as unknown as CoreState;

    await generateSessionSummary(state, updated, 'override/model');
    expect(capturedModel).toBe('override/model');
  });

  it('includes existing summary in prompt for incremental refinement', async () => {
    const session = await store.create('test/model', 'Test');
    await store.appendMessage(session.id, { role: 'user', content: 'Tell me about cats' });
    await store.appendMessage(session.id, { role: 'assistant', content: 'Cats are great.' });
    await store.updateSummary(session.id, 'Discussion about cats.', 1);

    const updated = await store.get(session.id, true);
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const state = {
      async* chat(_model: string, messages: Array<{ role: string; content: string }>) {
        capturedMessages = messages;
        yield { type: 'text' as const, text: 'Refined summary.' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    } as unknown as CoreState;

    await generateSessionSummary(state, updated);
    const hasExistingSummary = capturedMessages.some(
      (m) => m.content.includes('Previous summary') && m.content.includes('Discussion about cats.'),
    );
    expect(hasExistingSummary).toBe(true);
  });
});

describe('maybeSummarize', () => {
  it('triggers at SUMMARY_INTERVAL (10) user messages', async () => {
    const session = await store.create('test/model', 'Test');

    for (let i = 0; i < 10; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    const state = createMockState('Summary after 10 turns.');
    await maybeSummarize(state, session.id, store);

    const updated = await store.get(session.id, true);
    expect(updated.summary).toBe('Summary after 10 turns.');
    expect(updated.summaryMessageCount).toBe(10);
  });

  it('does not trigger below SUMMARY_INTERVAL', async () => {
    const session = await store.create('test/model', 'Test');

    for (let i = 0; i < 5; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    const state = createMockState('Should not appear.');
    await maybeSummarize(state, session.id, store);

    const updated = await store.get(session.id, true);
    expect(updated.summary).toBeUndefined();
  });

  it('does not trigger at non-interval counts (e.g. 13)', async () => {
    const session = await store.create('test/model', 'Test');

    for (let i = 0; i < 13; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    const state = createMockState('Should not appear.');
    await maybeSummarize(state, session.id, store);

    const updated = await store.get(session.id, true);
    expect(updated.summary).toBeUndefined();
  });

  it('skips if summary is already current (summaryMessageCount matches)', async () => {
    const session = await store.create('test/model', 'Test');

    for (let i = 0; i < 10; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    await store.updateSummary(session.id, 'Already summarized.', 10);

    let chatCalled = false;
    const state = {
      async* chat() {
        chatCalled = true;
        yield { type: 'text' as const, text: 'New summary.' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    } as unknown as CoreState;

    await maybeSummarize(state, session.id, store);

    expect(chatCalled).toBe(false);
    const updated = await store.get(session.id, true);
    expect(updated.summary).toBe('Already summarized.');
  });

  it('catches errors and does not throw', async () => {
    const session = await store.create('test/model', 'Test');

    for (let i = 0; i < 10; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = createErrorState();

    await expect(maybeSummarize(state, session.id, store)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Summarizer]'),
    );
    consoleSpy.mockRestore();
  });

  it('triggers again at 20 user messages', async () => {
    const session = await store.create('test/model', 'Test');

    for (let i = 0; i < 10; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    const state1 = createMockState('First summary.');
    await maybeSummarize(state1, session.id, store);
    expect((await store.get(session.id, true)).summary).toBe('First summary.');

    for (let i = 10; i < 20; i++) {
      await store.appendMessage(session.id, { role: 'user', content: `msg ${i + 1}` });
      await store.appendMessage(session.id, { role: 'assistant', content: `reply ${i + 1}` });
    }

    const state2 = createMockState('Updated summary.');
    await maybeSummarize(state2, session.id, store);

    const updated = await store.get(session.id, true);
    expect(updated.summary).toBe('Updated summary.');
    expect(updated.summaryMessageCount).toBe(20);
  });
});
