/**
 * CoreState unit tests — builder API, config merge, providers/models, chat, health.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConfigFile } from './config.js';
import type { DiscoveredModel } from './engines.js';
import { MemorySecretStore } from './secrets.js';
import { ToolRegistry } from './tool-registry.js';

// ── Partial engines mock (preserve real getEngine for addProvider policy tests) ──

const mockStreamChat = vi.fn();
const mockFetchModels = vi.fn();

vi.mock('./engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engines.js')>();
  return {
    ...actual,
    streamChat: (...args: unknown[]) => mockStreamChat(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  };
});

import { CoreState } from './state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDiscovered(ids: string[]): DiscoveredModel[] {
  return ids.map((id) => ({
    id,
    engine: 'mock',
    contextWindow: 128000,
    capabilities: { supportsTools: true, supportsVision: false },
  }));
}

async function* fakeTextStream(text = 'hello'): AsyncGenerator<{ type: string; text?: string; finishReason?: string }> {
  yield { type: 'text', text };
  yield { type: 'done', finishReason: 'stop' };
}

async function collectChat(
  core: CoreState,
  modelId: string,
  messages: Array<{ role: string; content: string }> = [{ role: 'user', content: 'hi' }],
  requestParams?: Parameters<CoreState['chat']>[2],
  toolOptions?: Parameters<CoreState['chat']>[3],
  toolExecutor?: Parameters<CoreState['chat']>[4],
  inlinePolicy?: Parameters<CoreState['chat']>[5],
): Promise<Array<{ type: string; text?: string; error?: string; finishReason?: string }>> {
  const chunks = [];
  for await (const chunk of core.chat(modelId, messages, requestParams, toolOptions, toolExecutor, inlinePolicy)) {
    chunks.push(chunk);
  }
  return chunks;
}

function createCore(overrides?: {
  config?: ConfigFile;
  secretStore?: MemorySecretStore;
}): CoreState {
  return new CoreState({
    secretStore: overrides?.secretStore ?? new MemorySecretStore(),
    configLoader: () => overrides?.config ?? { providers: {} },
  });
}

const mockProviderConfig: ConfigFile = {
  providers: {
    'my-mock': {
      engine: 'mock',
      models: { echo: {}, fixed: {} },
    },
    openrouter: {
      engine: 'openrouter',
      api_key_keychain_name: 'OR_KEY',
      models: { 'model-a': {} },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchModels.mockResolvedValue(makeDiscovered(['echo', 'fixed']));
  mockStreamChat.mockReturnValue(fakeTextStream());
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OR_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

// ── addProvider endpoint policy (DR-040 / A3) ────────────────────────────────

describe('CoreState.addProvider endpoint policy', () => {
  it('rejects non-allowlisted hosts when allowed_provider_hosts is set', async () => {
    const core = createCore({
      config: { providers: {}, server: { allowed_provider_hosts: ['approved.example'] } },
    });

    await expect(
      core.addProvider('evil', {
        engine: 'openai',
        baseUrl: 'https://evil.example/v1',
      }),
    ).rejects.toThrow(/not in server\.allowed_provider_hosts|not allowlisted|allowed_provider_hosts/i);
  });

  it('accepts allowlisted hosts and audits endpoint + secret changes', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const core = createCore({
      config: { providers: {}, server: { allowed_provider_hosts: ['approved.example'] } },
    });

    await core.addProvider('approved', {
      engine: 'openai',
      baseUrl: 'https://approved.example/v1',
      apiKey: 'sk-test-not-logged',
    });

    const providers = await core.listProviders();
    const added = providers.find((p) => p.id === 'approved');
    expect(added?.baseUrl).toBe('https://approved.example/v1');

    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[Audit] provider endpoint changed') && l.includes('source=core-add'))).toBe(true);
    expect(lines.some((l) => l.includes('[Audit] secret changed') && l.includes('source=core-add'))).toBe(true);
    expect(lines.every((l) => !l.includes('sk-test-not-logged'))).toBe(true);
  });

  it('allows loopback http and default https when allowlist is unset', async () => {
    const core = createCore();

    await expect(
      core.addProvider('local', {
        engine: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      core.addProvider('cloud', {
        engine: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      core.addProvider('evil-http', {
        engine: 'openai',
        baseUrl: 'http://evil.example/v1',
      }),
    ).rejects.toThrow();
  });

  it('rejects unknown engine', async () => {
    const core = createCore();
    await expect(
      core.addProvider('bad', { engine: 'not-a-real-engine' }),
    ).rejects.toThrow(/Unknown engine/);
  });

  it('stores api key env var without writing to secret store', async () => {
    const store = new MemorySecretStore();
    const core = createCore({ secretStore: store });

    await core.addProvider('env-prov', {
      engine: 'openrouter',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
    });

    expect(await store.has('abbenay.env-prov')).toBe(false);
    const config = core.loadProviderConfig();
    expect(config['env-prov']?.api_key_env_var_name).toBe('OPENROUTER_API_KEY');
  });
});

// ── Builder API ──────────────────────────────────────────────────────────────

describe('CoreState builder API', () => {
  it('removeProvider clears in-memory provider and health', async () => {
    const core = createCore();
    await core.addProvider('tmp', { engine: 'mock', models: { echo: {} } });
    expect(core.hasProvider('tmp')).toBe(true);

    expect(core.removeProvider('tmp')).toBe(true);
    expect(core.removeProvider('tmp')).toBe(false);
    expect(core.hasProvider('tmp')).toBe(false);
  });

  it('addModel updates in-memory provider models', async () => {
    const core = createCore();
    await core.addProvider('my-mock', { engine: 'mock', models: { echo: {} } });

    core.addModel('my-mock', 'fixed', { temperature: 0.2 });
    const config = core.loadProviderConfig();
    expect(config['my-mock']?.models?.fixed?.temperature).toBe(0.2);
  });

  it('addModel promotes disk provider to in-memory', () => {
    const core = createCore({ config: mockProviderConfig });
    core.addModel('my-mock', 'slow', {});
    const config = core.loadProviderConfig();
    expect(config['my-mock']?.models?.slow).toEqual({});
    expect(config['my-mock']?.models?.echo).toEqual({});
  });

  it('addModel throws when provider missing', () => {
    const core = createCore();
    expect(() => core.addModel('missing', 'echo')).toThrow(/not found/i);
  });

  it('removeModel deletes from in-memory and disk-backed providers', async () => {
    const core = createCore();
    await core.addProvider('my-mock', { engine: 'mock', models: { echo: {}, fixed: {} } });

    expect(core.removeModel('my-mock', 'echo')).toBe(true);
    expect(core.removeModel('my-mock', 'echo')).toBe(false);
    expect(core.loadProviderConfig()['my-mock']?.models?.echo).toBeUndefined();

    const diskCore = createCore({ config: mockProviderConfig });
    expect(diskCore.removeModel('my-mock', 'echo')).toBe(true);
    expect(diskCore.removeModel('my-mock', 'missing')).toBe(false);
  });

  it('hasProvider checks disk and in-memory providers', async () => {
    const core = createCore({ config: mockProviderConfig });
    expect(core.hasProvider('my-mock')).toBe(true);
    expect(core.hasProvider('nope')).toBe(false);

    await core.addProvider('runtime', { engine: 'mock' });
    expect(core.hasProvider('runtime')).toBe(true);
  });

  it('in-memory providers override disk config with same id', async () => {
    const core = createCore({
      config: {
        providers: {
          shared: { engine: 'mock', models: { echo: {} } },
        },
      },
    });
    await core.addProvider('shared', { engine: 'mock', models: { fixed: {} } });

    const models = Object.keys(core.loadProviderConfig().shared?.models ?? {});
    expect(models).toEqual(['fixed']);
  });
});

// ── resolveApiKey / credentials ──────────────────────────────────────────────

describe('CoreState.resolveApiKey', () => {
  it('reads keychain value from secret store', async () => {
    const store = new MemorySecretStore();
    await store.set('OR_KEY', 'sk-from-store');
    const core = createCore({ config: mockProviderConfig, secretStore: store });

    expect(await core.resolveApiKey('openrouter')).toBe('sk-from-store');
  });

  it('falls back to configured env var then engine default env var', async () => {
    const core = createCore({
      config: {
        providers: {
          or: { engine: 'openrouter', api_key_env_var_name: 'OR_KEY', models: {} },
        },
      },
    });

    process.env.OR_KEY = 'sk-env';
    expect(await core.resolveApiKey('or')).toBe('sk-env');

    delete process.env.OR_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-default-env';
    expect(await core.resolveApiKey('or')).toBe('sk-default-env');
  });

  it('returns null for missing provider', async () => {
    const core = createCore();
    expect(await core.resolveApiKey('missing')).toBeNull();
  });

  it('resolveProviderCredentials returns api key and base url', async () => {
    const store = new MemorySecretStore();
    await store.set('OR_KEY', 'sk-test');
    const core = createCore({
      secretStore: store,
      config: {
        providers: {
          or: {
            engine: 'openrouter',
            api_key_keychain_name: 'OR_KEY',
            base_url: 'https://custom.example/v1',
            models: {},
          },
        },
      },
    });

    expect(await core.resolveProviderCredentials('or')).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://custom.example/v1',
    });
    expect(await core.resolveProviderCredentials('missing')).toEqual({});
  });
});

// ── listProviders / listModels / discoverModels ──────────────────────────────

describe('CoreState.listProviders', () => {
  it('returns configured status from keychain and skips unknown engines', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemorySecretStore();
    await store.set('OR_KEY', 'sk-test');
    const core = createCore({
      secretStore: store,
      config: {
        providers: {
          'my-mock': { engine: 'mock', models: { echo: {} } },
          openrouter: { engine: 'openrouter', api_key_keychain_name: 'OR_KEY', models: {} },
          bad: { engine: 'unknown-engine-xyz', models: {} },
        },
      },
    });

    const providers = await core.listProviders();
    expect(providers.map((p) => p.id).sort()).toEqual(['my-mock', 'openrouter']);
    expect(providers.find((p) => p.id === 'my-mock')?.configured).toBe(true);
    expect(providers.find((p) => p.id === 'openrouter')?.configured).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('CoreState.listEngines', () => {
  it('returns registered engines including mock', () => {
    const core = createCore();
    const engines = core.listEngines();
    expect(engines.some((e) => e.id === 'mock')).toBe(true);
    expect(engines.some((e) => e.id === 'openai')).toBe(true);
  });
});

describe('CoreState.listModels', () => {
  it('returns composite model ids for configured mock provider', async () => {
    const core = createCore({ config: mockProviderConfig });
    const models = await core.listModels();
    expect(models.map((m) => m.id).sort()).toEqual(['my-mock/echo', 'my-mock/fixed']);
    expect(models[0].engineModelId).toBeDefined();
  });

  it('skips providers without keys when engine requires key', async () => {
    const core = createCore({ config: mockProviderConfig });
    const models = await core.listModels();
    expect(models.every((m) => m.provider !== 'openrouter')).toBe(true);
  });

  it('continues when fetchModels throws for one provider', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchModels.mockRejectedValueOnce(new Error('network down'));
    const core = createCore({
      config: {
        providers: {
          broken: { engine: 'mock', models: { echo: {} } },
          good: { engine: 'mock', models: { fixed: {} } },
        },
      },
    });

    const models = await core.listModels();
    expect(models.some((m) => m.id === 'good/fixed')).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('CoreState.discoverModels', () => {
  it('returns empty for unknown engine or missing api key', async () => {
    const core = createCore();
    expect(await core.discoverModels('not-real')).toEqual([]);
    expect(await core.discoverModels('openrouter')).toEqual([]);
  });

  it('returns models from fetchModels and swallows errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchModels.mockResolvedValueOnce(makeDiscovered(['echo']));
    const core = createCore();
    expect(await core.discoverModels('mock')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'echo' }),
    ]));

    mockFetchModels.mockRejectedValueOnce(new Error('boom'));
    expect(await core.discoverModels('mock')).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────

describe('CoreState.chat', () => {
  it('errors on invalid composite model id', async () => {
    const core = createCore({ config: mockProviderConfig });
    const chunks = await collectChat(core, 'no-slash-id');
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(chunks.at(-1)?.finishReason).toBe('error');
  });

  it('errors when provider or api key missing', async () => {
    const core = createCore({ config: mockProviderConfig });
    const missingProvider = await collectChat(core, 'missing/echo');
    expect(missingProvider.some((c) => c.error?.includes('Provider not found'))).toBe(true);

    const missingKey = await collectChat(core, 'openrouter/model-a');
    expect(missingKey.some((c) => c.error?.includes('No API key'))).toBe(true);
  });

  it('errors on passthrough without client tools', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const core = createCore({ config: mockProviderConfig });
    const chunks = await collectChat(core, 'my-mock/echo', [{ role: 'user', content: 'hi' }], undefined, {
      toolMode: 'passthrough',
    });
    expect(chunks.some((c) => c.error?.includes('passthrough'))).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  it('streams via mock engine and merges params', async () => {
    const core = createCore({
      config: {
        providers: {
          'my-mock': {
            engine: 'mock',
            models: {
              echo: {
                temperature: 0.3,
                system_prompt: 'Be brief.',
                system_prompt_mode: 'prepend',
              },
            },
          },
        },
      },
    });

    const chunks = await collectChat(
      core,
      'my-mock/echo',
      [{ role: 'system', content: 'Original' }, { role: 'user', content: 'hi' }],
      { temperature: 0.9 },
      { toolMode: 'none' },
    );

    expect(chunks.some((c) => c.type === 'text')).toBe(true);
    expect(mockStreamChat).toHaveBeenCalled();
    const messages = mockStreamChat.mock.calls[0][2];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Be brief.');
    expect(messages[0].content).toContain('Original');
    expect(mockStreamChat.mock.calls[0][5]?.temperature).toBe(0.9);
  });

  it('uses tool registry in auto mode with filter and approval callback', async () => {
    const core = createCore({
      config: {
        providers: { 'my-mock': { engine: 'mock', models: { echo: {} } } },
        tool_policy: { auto_approve: ['local:test/tool'] },
      },
    });
    const registry = new ToolRegistry();
    registry.register('test', 'local', [
      {
        name: 'tool',
        description: 'test tool',
        inputSchema: '{}',
        executor: async () => ({ ok: true }),
      },
      {
        name: 'other',
        description: 'other tool',
        inputSchema: '{}',
        executor: async () => ({ ok: true }),
      },
    ]);
    core.toolRegistry = registry;

    const onApproval = vi.fn().mockResolvedValue('allow');
    await collectChat(core, 'my-mock/echo', [{ role: 'user', content: 'run tool' }], undefined, {
      toolFilter: ['tool'],
      onToolApprovalNeeded: onApproval,
    });

    expect(mockStreamChat).toHaveBeenCalled();
    const tools = mockStreamChat.mock.calls[0][6];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('tool');
    expect(mockStreamChat.mock.calls[0][9]).toBe(10);
  });

  it('applies inline policy without inheriting named policy fields', async () => {
    const core = createCore({
      config: {
        providers: {
          'my-mock': {
            engine: 'mock',
            models: {
              echo: { policy: 'precise' },
            },
          },
        },
      },
    });

    await collectChat(
      core,
      'my-mock/echo',
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      undefined,
      { sampling: { temperature: 0.5 } },
    );

    expect(mockStreamChat.mock.calls[0][5]?.temperature).toBe(0.5);
    expect(mockStreamChat.mock.calls[0][5]?.maxTokens).toBeUndefined();
  });

  it('retries invalid json when retry_on_invalid_json policy is set', async () => {
    const jsonPayload = '{"ok":true}';
    let callCount = 0;
    mockStreamChat.mockImplementation(() => (async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'text', text: 'not json' };
        yield { type: 'done', finishReason: 'stop' };
      } else {
        yield { type: 'text', text: jsonPayload };
        yield { type: 'done', finishReason: 'stop' };
      }
    })());

    const core = createCore({
      config: {
        providers: {
          'my-mock': { engine: 'mock', models: { echo: {} } },
        },
      },
    });

    const chunks = await collectChat(
      core,
      'my-mock/echo',
      [{ role: 'user', content: 'json please' }],
      undefined,
      undefined,
      undefined,
      {
        output: { format: 'json_only' },
        reliability: { retry_on_invalid_json: true },
      },
    );

    expect(mockStreamChat).toHaveBeenCalledTimes(2);
    expect(chunks.some((c) => c.type === 'text' && c.text === jsonPayload)).toBe(true);
  });

  it('uses append system prompt mode from inline policy', async () => {
    const core = createCore({
      config: {
        providers: {
          'my-mock': {
            engine: 'mock',
            models: {
              echo: {
                system_prompt: 'Model prompt',
                system_prompt_mode: 'prepend',
              },
            },
          },
        },
      },
    });

    await collectChat(
      core,
      'my-mock/echo',
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      undefined,
      {
        output: {
          system_prompt_snippet: 'Policy snippet',
          system_prompt_mode: 'append',
        },
      },
    );

    const messages = mockStreamChat.mock.calls[0][2];
    expect(messages[0].content).toBe('Model prompt\n\nPolicy snippet');
  });
});

// ── runHealthChecks ──────────────────────────────────────────────────────────

describe('CoreState.runHealthChecks', () => {
  it('marks providers healthy when models are returned', async () => {
    mockFetchModels.mockResolvedValue(makeDiscovered(['echo']));
    const core = createCore({ config: mockProviderConfig });
    await core.runHealthChecks();
    const providers = await core.listProviders();
    expect(providers.find((p) => p.id === 'my-mock')?.healthy).toBe(true);
  });

  it('marks providers unhealthy on fetch failure or missing key', async () => {
    mockFetchModels.mockRejectedValue(new Error('down'));
    const core = createCore({ config: mockProviderConfig });
    await core.runHealthChecks();
    const providers = await core.listProviders();
    expect(providers.find((p) => p.id === 'my-mock')?.healthy).toBe(false);
    expect(providers.find((p) => p.id === 'openrouter')?.healthy).toBe(false);
  });
});
