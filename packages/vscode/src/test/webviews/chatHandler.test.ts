import * as assert from 'assert';
import { handleChatMessage, cancelActiveStream } from '../../webviews/chat/chatHandler';
import { createMockWebview } from '../helpers/mockWebview';
import { createMockDaemonClient } from '../helpers/mockDaemonClient';

suite('Chat Handler', () => {
  test('ready message should send models and sessions', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient();

    await handleChatMessage({ type: 'ready' }, webview, client);

    const messageTypes = webview.messages.map((m: unknown) => (m as { type: string }).type);
    assert.ok(messageTypes.includes('models'), 'Should send models');
    assert.ok(messageTypes.includes('sessions'), 'Should send sessions');
  });

  test('listModels should send model list', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      listModels: async () => [
        { id: 'openai/gpt-4', provider: 'openai', name: 'GPT-4', engine: 'openai' },
        { id: 'ollama/llama3', provider: 'ollama', name: 'Llama 3', engine: 'ollama' },
      ] as never,
    });

    await handleChatMessage({ type: 'listModels' }, webview, client);

    const msg = webview.messages[0] as { type: string; models: { id: string }[] };
    assert.strictEqual(msg.type, 'models');
    assert.strictEqual(msg.models.length, 2);
    assert.strictEqual(msg.models[0].id, 'openai/gpt-4');
  });

  test('createSession should send sessionCreated and refresh sessions', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      createSession: async (model: string, topic?: string) => ({
        id: 'session-123',
        model,
        topic: topic || 'New Chat',
        messages: [],
        messageCount: 0,
      }) as never,
    });

    await handleChatMessage(
      { type: 'createSession', model: 'openai/gpt-4', topic: 'Test Chat' },
      webview,
      client,
    );

    const messageTypes = webview.messages.map((m: unknown) => (m as { type: string }).type);
    assert.ok(messageTypes.includes('sessionCreated'), 'Should send sessionCreated');
    assert.ok(messageTypes.includes('sessions'), 'Should refresh sessions list');

    const created = webview.messages.find(
      (m: unknown) => (m as { type: string }).type === 'sessionCreated',
    ) as { type: string; session: { id: string; model: string } };
    assert.strictEqual(created.session.id, 'session-123');
    assert.strictEqual(created.session.model, 'openai/gpt-4');
  });

  test('deleteSession should call client and refresh sessions', async () => {
    let deletedId = '';
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      deleteSession: async (id: string) => { deletedId = id; },
    });

    await handleChatMessage(
      { type: 'deleteSession', sessionId: 'session-456' },
      webview,
      client,
    );

    assert.strictEqual(deletedId, 'session-456');
    const messageTypes = webview.messages.map((m: unknown) => (m as { type: string }).type);
    assert.ok(messageTypes.includes('sessions'), 'Should refresh sessions list');
  });

  test('cancelActiveStream should not throw when no stream active', () => {
    assert.doesNotThrow(() => cancelActiveStream());
  });

  test('error in handler should send error message to webview', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      listModels: async () => { throw new Error('Daemon unavailable'); },
    });

    await handleChatMessage({ type: 'listModels' }, webview, client);

    const msg = webview.messages[0] as { type: string; message: string; context: string };
    assert.strictEqual(msg.type, 'error');
    assert.strictEqual(msg.message, 'Daemon unavailable');
    assert.strictEqual(msg.context, 'listModels');
  });
});
