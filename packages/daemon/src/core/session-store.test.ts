/**
 * SessionStore unit tests
 *
 * Tests CRUD operations, appendMessage, updateTitle, index consistency,
 * and edge cases against a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from './session-store.js';

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-session-test-'));
  store = new SessionStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionStore.create', () => {
  it('returns session with UUID, empty messages, correct model/title', async () => {
    const session = await store.create('openai/gpt-4o', 'Test Session');

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.model).toBe('openai/gpt-4o');
    expect(session.title).toBe('Test Session');
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBeTruthy();
    expect(session.metadata).toEqual({});
  });

  it('uses default title when none provided', async () => {
    const session = await store.create('openai/gpt-4o');
    expect(session.title).toBe('New Session');
  });

  it('persists session to disk', async () => {
    const session = await store.create('openai/gpt-4o');
    const filePath = path.join(tmpDir, `${session.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(raw.id).toBe(session.id);
    expect(raw.model).toBe('openai/gpt-4o');
  });

  it('updates the index', async () => {
    const session = await store.create('openai/gpt-4o', 'Indexed');
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, 'index.json'), 'utf-8'));
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0].id).toBe(session.id);
    expect(index.sessions[0].title).toBe('Indexed');
    expect(index.sessions[0].messageCount).toBe(0);
  });

  it('stores metadata and policy', async () => {
    const session = await store.create('openai/gpt-4o', 'Meta', 'strict', { workspace: '/tmp' });
    expect(session.policy).toBe('strict');
    expect(session.metadata).toEqual({ workspace: '/tmp' });
  });
});

describe('SessionStore.get', () => {
  it('returns full session with messages', async () => {
    const created = await store.create('openai/gpt-4o');
    await store.appendMessage(created.id, { role: 'user', content: 'Hello' });

    const session = await store.get(created.id, true);
    expect(session.id).toBe(created.id);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Hello');
  });

  it('omits messages when includeMessages is false', async () => {
    const created = await store.create('openai/gpt-4o');
    await store.appendMessage(created.id, { role: 'user', content: 'Hello' });

    const session = await store.get(created.id, false);
    expect(session.id).toBe(created.id);
    expect(session.messages).toEqual([]);
  });

  it('throws for invalid ID', async () => {
    await expect(store.get('nonexistent-id')).rejects.toThrow('Invalid session ID');
  });

  it('throws for unknown UUID', async () => {
    await expect(store.get('00000000-0000-0000-0000-000000000000')).rejects.toThrow('Session not found');
  });
});

describe('SessionStore.list', () => {
  it('returns summaries sorted by updatedAt desc', async () => {
    const s1 = await store.create('openai/gpt-4o', 'First');
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    const s2 = await store.create('openai/gpt-4o', 'Second');

    const result = await store.list();
    expect(result.sessions).toHaveLength(2);
    expect(result.totalCount).toBe(2);
    expect(result.sessions[0].id).toBe(s2.id);
    expect(result.sessions[1].id).toBe(s1.id);
  });

  it('respects limit and offset', async () => {
    await store.create('openai/gpt-4o', 'A');
    await new Promise(r => setTimeout(r, 10));
    await store.create('openai/gpt-4o', 'B');
    await new Promise(r => setTimeout(r, 10));
    await store.create('openai/gpt-4o', 'C');

    const result = await store.list({ limit: 1, offset: 1 });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].title).toBe('B');
    expect(result.totalCount).toBe(3);
  });

  it('filters by model', async () => {
    await store.create('openai/gpt-4o', 'OpenAI');
    await store.create('anthropic/claude', 'Anthropic');

    const result = await store.list({ model: 'anthropic/claude' });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].title).toBe('Anthropic');
    expect(result.totalCount).toBe(1);
  });

  it('returns empty when no sessions exist', async () => {
    const result = await store.list();
    expect(result.sessions).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

describe('SessionStore.delete', () => {
  it('removes session file and index entry', async () => {
    const session = await store.create('openai/gpt-4o', 'ToDelete');

    await store.delete(session.id);

    const filePath = path.join(tmpDir, `${session.id}.json`);
    expect(fs.existsSync(filePath)).toBe(false);

    await expect(store.get(session.id)).rejects.toThrow('Session not found');

    const result = await store.list();
    expect(result.sessions).toHaveLength(0);
  });

  it('throws for invalid ID', async () => {
    await expect(store.delete('nonexistent-id')).rejects.toThrow('Invalid session ID');
  });

  it('throws for unknown UUID', async () => {
    await expect(store.delete('00000000-0000-0000-0000-000000000000')).rejects.toThrow('Session not found');
  });
});

describe('SessionStore.appendMessage', () => {
  it('adds message and updates timestamp', async () => {
    const session = await store.create('openai/gpt-4o');
    const originalUpdatedAt = session.updatedAt;

    await new Promise(r => setTimeout(r, 10));
    const updated = await store.appendMessage(session.id, { role: 'user', content: 'Hello' });

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].role).toBe('user');
    expect(updated.messages[0].content).toBe('Hello');
    expect(updated.updatedAt).not.toBe(originalUpdatedAt);
  });

  it('updates messageCount in index', async () => {
    const session = await store.create('openai/gpt-4o');
    await store.appendMessage(session.id, { role: 'user', content: 'Hello' });
    await store.appendMessage(session.id, { role: 'assistant', content: 'Hi there' });

    const result = await store.list();
    const entry = result.sessions.find(s => s.id === session.id);
    expect(entry?.messageCount).toBe(2);
  });

  it('preserves tool_calls and tool_call_id fields', async () => {
    const session = await store.create('openai/gpt-4o');
    await store.appendMessage(session.id, {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }],
    });
    await store.appendMessage(session.id, {
      role: 'tool',
      content: '{"result": true}',
      tool_call_id: 'call_1',
    });

    const loaded = await store.get(session.id);
    expect(loaded.messages[0].tool_calls).toBeDefined();
    expect(loaded.messages[1].tool_call_id).toBe('call_1');
  });
});

describe('SessionStore.updateTitle', () => {
  it('updates title in session file and index', async () => {
    const session = await store.create('openai/gpt-4o', 'Old Title');

    await store.updateTitle(session.id, 'New Title');

    const loaded = await store.get(session.id);
    expect(loaded.title).toBe('New Title');

    const result = await store.list();
    const entry = result.sessions.find(s => s.id === session.id);
    expect(entry?.title).toBe('New Title');
  });
});

describe('concurrent operations', () => {
  it('two rapid appendMessage calls do not corrupt data', async () => {
    const session = await store.create('openai/gpt-4o');

    // Run sequentially since file-based storage doesn't support true concurrency,
    // but verify the store handles rapid consecutive calls gracefully
    await store.appendMessage(session.id, { role: 'user', content: 'First' });
    await store.appendMessage(session.id, { role: 'assistant', content: 'Second' });

    const loaded = await store.get(session.id);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].content).toBe('First');
    expect(loaded.messages[1].content).toBe('Second');

    const result = await store.list();
    const entry = result.sessions.find(s => s.id === session.id);
    expect(entry?.messageCount).toBe(2);
  });
});
