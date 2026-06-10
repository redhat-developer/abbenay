import * as assert from 'assert';
import { handleProviderMessage } from '../../webviews/provider/providerHandler';
import { createMockWebview } from '../helpers/mockWebview';
import { createMockDaemonClient } from '../helpers/mockDaemonClient';

/* eslint-disable @typescript-eslint/no-explicit-any */

suite('Provider Handler', () => {
  test('ready message should send providers, templates, engines, and secrets', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient();

    await handleProviderMessage({ type: 'ready' }, webview, client);

    const messageTypes = webview.messages.map((m: unknown) => (m as { type: string }).type);
    assert.ok(messageTypes.includes('providers'), 'Should send providers');
    assert.ok(messageTypes.includes('templates'), 'Should send templates');
    assert.ok(messageTypes.includes('engines'), 'Should send engines');
    assert.ok(messageTypes.includes('secrets'), 'Should send secrets');
  });

  test('getEngines should send engine list', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      listEngines: async () => [
        { id: 'openai', requiresKey: true, defaultBaseUrl: 'https://api.openai.com/v1', defaultEnvVar: 'OPENAI_API_KEY' },
        { id: 'ollama', requiresKey: false, defaultBaseUrl: 'http://localhost:11434', defaultEnvVar: '' },
      ] as never,
    });

    await handleProviderMessage({ type: 'getEngines' }, webview, client);

    const msg = webview.messages[0] as { type: string; engines: { id: string; requiresKey: boolean }[] };
    assert.strictEqual(msg.type, 'engines');
    assert.strictEqual(msg.engines.length, 2);
    assert.strictEqual(msg.engines[0].id, 'openai');
    assert.strictEqual(msg.engines[0].requiresKey, true);
  });

  test('discoverModels should pass apiKey and baseUrl to client', async () => {
    let capturedOptions: any = {};
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      discoverModels: async (_engineId: string, options?: any) => {
        capturedOptions = options || {};
        return [
          { id: 'gpt-4', provider: 'openai', name: 'GPT-4', engine: 'openai' },
        ];
      },
    });

    await handleProviderMessage(
      { type: 'discoverModels', engineId: 'openai', apiKey: 'sk-test', baseUrl: 'https://custom.api/v1' },
      webview,
      client,
    );

    assert.strictEqual(capturedOptions.apiKey, 'sk-test');
    assert.strictEqual(capturedOptions.baseUrl, 'https://custom.api/v1');

    const msg = webview.messages[0] as { type: string; models: { id: string }[] };
    assert.strictEqual(msg.type, 'discoveredModels');
    assert.strictEqual(msg.models.length, 1);
    assert.strictEqual(msg.models[0].id, 'gpt-4');
  });

  test('getConfig should forward config from client', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      getConfig: async () => ({
        config: { providers: { 'my-openai': { engine: 'openai' } } } as any,
        path: '/home/user/.config/abbenay/config.yaml',
      }),
    });

    await handleProviderMessage({ type: 'getConfig' }, webview, client);

    const msg = webview.messages[0] as { type: string; config: unknown; path: string };
    assert.strictEqual(msg.type, 'config');
    assert.strictEqual(msg.path, '/home/user/.config/abbenay/config.yaml');
  });

  test('error in handler should send error message to webview', async () => {
    const webview = createMockWebview();
    const client = createMockDaemonClient({
      listEngines: async () => { throw new Error('Connection refused'); },
    });

    await handleProviderMessage({ type: 'getEngines' }, webview, client);

    const msg = webview.messages[0] as { type: string; message: string; context: string };
    assert.strictEqual(msg.type, 'error');
    assert.strictEqual(msg.message, 'Connection refused');
    assert.strictEqual(msg.context, 'getEngines');
  });
});
