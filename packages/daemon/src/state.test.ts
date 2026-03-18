/**
 * DaemonState unit tests
 *
 * Tests the virtual provider/model layer: listModels, listProviders, 
 * discoverModels, chat, and health checks.
 *
 * Mocks: core/config, core/engines, daemon/secrets/keychain.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConfigFile, ModelConfig } from './core/config.js';
import type { EngineInfo, DiscoveredModel } from './core/engines.js';

// ── Mock: core/config ────────────────────────────────────────────────────────

const mockLoadConfig = vi.fn().mockReturnValue({ providers: {} });
const mockLoadWorkspaceConfig = vi.fn().mockReturnValue(null);
const mockMergeConfigs = vi.fn();
const mockMergeMultipleWorkspaceConfigs = vi.fn().mockReturnValue({ providers: {} });
const mockResolveEngineModelId = vi.fn().mockImplementation(
  (name: string, cfg: ModelConfig) => cfg.model_id || name
);

vi.mock('./core/config.js', () => ({
  loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
  loadWorkspaceConfig: (...a: unknown[]) => mockLoadWorkspaceConfig(...a),
  mergeConfigs: (...a: unknown[]) => mockMergeConfigs(...a),
  mergeMultipleWorkspaceConfigs: (...a: unknown[]) => mockMergeMultipleWorkspaceConfigs(...a),
  resolveEngineModelId: (...a: unknown[]) => mockResolveEngineModelId(...a),
}));

// ── Mock: core/engines ───────────────────────────────────────────────────────

const MOCK_ENGINE: EngineInfo = {
  id: 'mock',
  requiresKey: false,
  supportsTools: false,
  createModel: () => { throw new Error('mock'); },
};

const OPENROUTER_ENGINE: EngineInfo = {
  id: 'openrouter',
  requiresKey: true,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  defaultEnvVar: 'OPENROUTER_API_KEY',
  supportsTools: true,
  createModel: () => { throw new Error('mock'); },
};

const mockGetEngines = vi.fn().mockReturnValue([MOCK_ENGINE, OPENROUTER_ENGINE]);
const mockGetEngine = vi.fn().mockImplementation((id: string) => {
  if (id === 'mock') return MOCK_ENGINE;
  if (id === 'openrouter') return OPENROUTER_ENGINE;
  return undefined;
});
const mockFetchModels = vi.fn().mockResolvedValue([]);
const mockStreamChat = vi.fn();

vi.mock('./core/engines.js', () => ({
  getEngines: (...a: unknown[]) => mockGetEngines(...a),
  getEngine: (...a: unknown[]) => mockGetEngine(...a),
  fetchModels: (...a: unknown[]) => mockFetchModels(...a),
  streamChat: (...a: unknown[]) => mockStreamChat(...a),
}));

// ── Mock: daemon/secrets/keychain ────────────────────────────────────────────

const mockSecretStoreData = new Map<string, string>();

vi.mock('./daemon/secrets/keychain.js', () => ({
  KeychainSecretStore: class {
    async get(key: string): Promise<string | null> {
      return mockSecretStoreData.get(key) ?? null;
    }
    async set(key: string, value: string): Promise<void> {
      mockSecretStoreData.set(key, value);
    }
    async delete(key: string): Promise<boolean> {
      return mockSecretStoreData.delete(key);
    }
    async has(key: string): Promise<boolean> {
      return mockSecretStoreData.has(key);
    }
  },
}));

// ── Import DaemonState (after mocks) ─────────────────────────────────────────

import { DaemonState, ClientType } from './daemon/state.js';
import { protoToPolicyConfig, authorizeInlinePolicy, authorizeMcpRegister } from './daemon/server/abbenay-service.js';
import * as grpc from '@grpc/grpc-js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create DiscoveredModel objects */
function makeDiscovered(ids: string[]): DiscoveredModel[] {
  return ids.map(id => ({
    id,
    engine: 'mock',
    contextWindow: 128000,
    capabilities: { supportsTools: true, supportsVision: false },
  }));
}

// ── Setup ────────────────────────────────────────────────────────────────────

let state: DaemonState;

beforeEach(() => {
  vi.clearAllMocks();
  mockSecretStoreData.clear();

  state = new DaemonState();

  // Defaults
  mockLoadConfig.mockReturnValue({ providers: {} });
  mockLoadWorkspaceConfig.mockReturnValue(null);
  mockMergeConfigs.mockImplementation((user: ConfigFile, ws: ConfigFile | null) => {
    if (!ws) return user;
    return { providers: { ...user.providers, ...ws.providers } };
  });
  mockMergeMultipleWorkspaceConfigs.mockReturnValue({ providers: {} });
  mockFetchModels.mockResolvedValue([]);
});

// ── listModels ───────────────────────────────────────────────────────────────

describe('DaemonState.listModels', () => {
  it('should return empty when no providers configured', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockMergeConfigs.mockReturnValue({ providers: {} });

    const models = await state.listModels();
    expect(models).toEqual([]);
  });

  it('should return models for a configured provider with key', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'OR_KEY',
          models: {
            'openrouter/anthropic/claude-opus-4.5': {},
            'openrouter/anthropic/claude-opus-4.6': {},
          },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('OR_KEY', 'sk-test');
    mockFetchModels.mockResolvedValue(makeDiscovered([
      'openrouter/anthropic/claude-opus-4.5',
      'openrouter/anthropic/claude-opus-4.6',
      'openrouter/google/gemini-pro',
    ]));

    const models = await state.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('openrouter/openrouter/anthropic/claude-opus-4.5');
    expect(models[0].name).toBe('openrouter/anthropic/claude-opus-4.5');
    expect(models[0].provider).toBe('openrouter');
    expect(models[0].engine).toBe('openrouter');
  });

  it('should skip provider without key when engine requires key', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'OR_KEY',
          models: { 'model-a': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const models = await state.listModels();

    expect(models).toEqual([]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it('should include keyless provider models', async () => {
    const config: ConfigFile = {
      providers: {
        'my-mock': {
          engine: 'mock',
          models: { 'echo': {}, 'fixed': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockFetchModels.mockResolvedValue(makeDiscovered(['echo', 'fixed', 'counter']));

    const models = await state.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('my-mock/echo');
    expect(models[1].id).toBe('my-mock/fixed');
  });

  it('should skip provider with no models configured', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'KEY',
          models: {},
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('KEY', 'sk-test');

    const models = await state.listModels();
    expect(models).toEqual([]);
  });

  it('should attach per-model params from config', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'KEY',
          models: {
            'claude-precise': {
              model_id: 'openrouter/anthropic/claude-opus-4.6',
              temperature: 0.2,
              top_p: 0.5,
            },
          },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('KEY', 'sk-test');
    mockFetchModels.mockResolvedValue(makeDiscovered(['openrouter/anthropic/claude-opus-4.6']));

    const models = await state.listModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openrouter/claude-precise');
    expect(models[0].name).toBe('claude-precise');
    expect(models[0].engineModelId).toBe('openrouter/anthropic/claude-opus-4.6');
    expect(models[0].params?.temperature).toBe(0.2);
    expect(models[0].params?.top_p).toBe(0.5);
  });

  it('should use workspace config when workspace paths provided', async () => {
    const mergedConfig: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'KEY',
          models: { 'model-a': {} },
        },
      },
    };

    mockMergeMultipleWorkspaceConfigs.mockReturnValue(mergedConfig);
    mockSecretStoreData.set('KEY', 'sk-test');
    mockFetchModels.mockResolvedValue(makeDiscovered(['model-a', 'model-b']));

    const models = await state.listModels(['/tmp/ws1']);

    expect(mockMergeMultipleWorkspaceConfigs).toHaveBeenCalledWith(['/tmp/ws1']);
    expect(models).toHaveLength(1);
  });

  it('should continue with other providers if one errors', async () => {
    const config: ConfigFile = {
      providers: {
        'bad-provider': {
          engine: 'openrouter',
          api_key_keychain_name: 'BAD_KEY',
          models: { 'model-a': {} },
        },
        'good-mock': {
          engine: 'mock',
          models: { 'echo': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('BAD_KEY', 'sk-bad');
    mockFetchModels.mockImplementation(async (engineId: string) => {
      if (engineId === 'openrouter') throw new Error('API timeout');
      if (engineId === 'mock') return makeDiscovered(['echo']);
      return [];
    });

    const models = await state.listModels();

    const mockModels = models.filter(m => m.provider === 'good-mock');
    expect(mockModels).toHaveLength(1);
  });
});

// ── listProviders ────────────────────────────────────────────────────────────

describe('DaemonState.listProviders', () => {
  it('should return empty when no providers configured', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockMergeConfigs.mockReturnValue({ providers: {} });

    const providers = await state.listProviders();
    expect(providers).toEqual([]);
  });

  it('should return configured provider with correct fields', async () => {
    const config: ConfigFile = {
      providers: {
        'work-openrouter': {
          engine: 'openrouter',
          api_key_keychain_name: 'WOR_KEY',
          base_url: 'https://custom.openrouter.ai',
          models: { 'model-a': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('WOR_KEY', 'sk-test');

    const providers = await state.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('work-openrouter');
    expect(providers[0].engine).toBe('openrouter');
    expect(providers[0].configured).toBe(true);
    expect(providers[0].requiresKey).toBe(true);
    expect(providers[0].baseUrl).toBe('https://custom.openrouter.ai');
    expect(providers[0].defaultBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('should mark provider as unconfigured when key missing', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'MISSING_KEY',
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const providers = await state.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].configured).toBe(false);
  });

  it('should mark keyless provider as configured', async () => {
    const config: ConfigFile = {
      providers: {
        'my-mock': { engine: 'mock', models: { 'echo': {} } },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const providers = await state.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].configured).toBe(true);
    expect(providers[0].requiresKey).toBe(false);
  });

  it('should skip provider with unknown engine', async () => {
    const config: ConfigFile = {
      providers: {
        'bad-provider': { engine: 'nonexistent' },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const providers = await state.listProviders();
    expect(providers).toEqual([]);
  });
});

// ── discoverModels ───────────────────────────────────────────────────────────

describe('DaemonState.discoverModels', () => {
  it('should return models from engine', async () => {
    const discovered = makeDiscovered(['model-a', 'model-b']);
    mockFetchModels.mockResolvedValue(discovered);

    const models = await state.discoverModels('mock');

    expect(models).toEqual(discovered);
    expect(mockFetchModels).toHaveBeenCalledWith('mock', undefined, undefined);
  });

  it('should pass apiKey and baseUrl to fetchModels', async () => {
    mockFetchModels.mockResolvedValue([]);

    await state.discoverModels('openrouter', 'sk-key', 'https://custom.api');

    expect(mockFetchModels).toHaveBeenCalledWith('openrouter', 'sk-key', 'https://custom.api');
  });

  it('should return empty for key-required engine without key', async () => {
    const models = await state.discoverModels('openrouter');

    expect(models).toEqual([]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it('should return empty for unknown engine', async () => {
    const models = await state.discoverModels('nonexistent');

    expect(models).toEqual([]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });
});

// ── listEngines ──────────────────────────────────────────────────────────────

describe('DaemonState.listEngines', () => {
  it('should return all engines from adapter', () => {
    const engines = state.listEngines();

    expect(engines).toHaveLength(2);
    expect(engines[0].id).toBe('mock');
    expect(engines[1].id).toBe('openrouter');
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────

describe('DaemonState.chat', () => {
  it('should yield error for invalid composite ID (no slash)', async () => {
    const chunks = [];
    for await (const chunk of state.chat('no-slash-id', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('error');
    expect(chunks[1].type).toBe('done');
  });

  it('should yield error for unknown provider', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockMergeConfigs.mockReturnValue({ providers: {} });

    const chunks = [];
    for await (const chunk of state.chat('unknown/model', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('error');
    expect(chunks[1].type).toBe('done');
  });
});

// ── Inline policy resolution ─────────────────────────────────────────────────

describe('DaemonState.chat inline policy', () => {
  // Use 'precise' policy (no json retry) to avoid mock complexity
  const configWithPolicy: ConfigFile = {
    providers: {
      'my-mock': {
        engine: 'mock',
        models: {
          'echo': { policy: 'precise' },
        },
      },
    },
  };

  async function* fakeStream(): AsyncGenerator<{ type: string; text?: string; finishReason?: string }> {
    yield { type: 'text', text: 'hello' };
    yield { type: 'done', finishReason: 'stop' };
  }

  beforeEach(() => {
    mockLoadConfig.mockReturnValue(configWithPolicy);
    mockMergeConfigs.mockReturnValue(configWithPolicy);
  });

  it('should use named policy when no inline policy is provided', async () => {
    mockStreamChat.mockReturnValue(fakeStream());

    const chunks = [];
    for await (const chunk of state.chat('my-mock/echo', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    const callArgs = mockStreamChat.mock.calls[0];
    // streamChat params arg is index 5; 'precise' policy has temperature 0.15
    const params = callArgs[5];
    expect(params?.temperature).toBe(0.15);
  });

  it('should replace named policy with inline policy', async () => {
    mockStreamChat.mockReturnValue(fakeStream());

    const inlinePolicy = {
      sampling: { temperature: 0.0 },
      output: { max_tokens: 4096 },
    };

    const chunks = [];
    for await (const chunk of state.chat(
      'my-mock/echo',
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      undefined,
      inlinePolicy,
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    const callArgs = mockStreamChat.mock.calls[0];
    const params = callArgs[5];
    // Inline policy's temperature, not the named policy's 0.15
    expect(params?.temperature).toBe(0.0);
    expect(params?.maxTokens).toBe(4096);
  });

  it('should let ChatOptions override inline policy fields', async () => {
    mockStreamChat.mockReturnValue(fakeStream());

    const inlinePolicy = {
      sampling: { temperature: 0.0 },
      output: { max_tokens: 4096 },
    };

    const chunks = [];
    for await (const chunk of state.chat(
      'my-mock/echo',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.8 },
      undefined,
      undefined,
      inlinePolicy,
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    const callArgs = mockStreamChat.mock.calls[0];
    const params = callArgs[5];
    // ChatOptions temperature (0.8) overrides inline policy (0.0)
    expect(params?.temperature).toBe(0.8);
    // Inline policy's max_tokens still applies (no ChatOptions override)
    expect(params?.maxTokens).toBe(4096);
  });

  it('should not inherit named policy fields when inline policy is partial', async () => {
    mockStreamChat.mockReturnValue(fakeStream());

    // Inline policy only sets sampling — should NOT inherit precise's
    // output max_tokens or system_prompt_snippet
    const inlinePolicy = {
      sampling: { temperature: 0.5 },
    };

    const chunks = [];
    for await (const chunk of state.chat(
      'my-mock/echo',
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      undefined,
      inlinePolicy,
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    const callArgs = mockStreamChat.mock.calls[0];
    const params = callArgs[5];
    expect(params?.temperature).toBe(0.5);
    // Named policy 'precise' has max_tokens: 2048, but inline policy doesn't
    // set it — full replacement means no inheritance
    expect(params?.maxTokens).toBeUndefined();
  });
});

// ── runHealthChecks ──────────────────────────────────────────────────────────

describe('DaemonState.runHealthChecks', () => {
  it('should mark provider healthy when models discoverable', async () => {
    const config: ConfigFile = {
      providers: {
        'my-mock': { engine: 'mock', models: { 'echo': {} } },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockFetchModels.mockResolvedValue(makeDiscovered(['echo']));

    await state.runHealthChecks();

    const providers = await state.listProviders();
    expect(providers[0].healthy).toBe(true);
  });

  it('should mark provider unhealthy when engine unknown', async () => {
    const config: ConfigFile = {
      providers: {
        'bad': { engine: 'nonexistent' },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    await state.runHealthChecks();
  });
});

// ── Client management ────────────────────────────────────────────────────────

describe('DaemonState client management', () => {
  it('should register and unregister clients', () => {
    const clientId = state.registerClient(ClientType.VSCODE);

    expect(state.clientCount).toBe(1);
    expect(state.getClients()).toHaveLength(1);

    state.unregisterClient(clientId);
    expect(state.clientCount).toBe(0);
  });

  it('should track workspace paths', () => {
    const _clientId = state.registerClient(ClientType.VSCODE, false, '/tmp/workspace');
    const clients = state.getClients();

    expect(clients[0].workspacePath).toBe('/tmp/workspace');
    expect(clients[0].workspacePaths).toEqual(['/tmp/workspace']);
  });
});

// ── protoToPolicyConfig validation ───────────────────────────────────────────

describe('protoToPolicyConfig', () => {
  it('should convert a valid proto to PolicyConfig', () => {
    const result = protoToPolicyConfig({
      sampling: { temperature: 0.5, top_p: 0.9 },
      output: { format: 'json_only', max_tokens: 2048 },
      reliability: { retry_on_invalid_json: true, timeout: 30000 },
    });

    expect(result.sampling?.temperature).toBe(0.5);
    expect(result.sampling?.top_p).toBe(0.9);
    expect(result.output?.format).toBe('json_only');
    expect(result.output?.max_tokens).toBe(2048);
    expect(result.reliability?.retry_on_invalid_json).toBe(true);
    expect(result.reliability?.timeout).toBe(30000);
  });

  it('should reject invalid output.format', () => {
    expect(() => protoToPolicyConfig({
      output: { format: 'xml' },
    })).toThrow('Invalid output.format');
  });

  it('should reject invalid output.system_prompt_mode', () => {
    expect(() => protoToPolicyConfig({
      output: { system_prompt_mode: 'overwrite' },
    })).toThrow('Invalid output.system_prompt_mode');
  });

  it('should reject invalid tool.tool_mode', () => {
    expect(() => protoToPolicyConfig({
      tool: { tool_mode: 'force' },
    })).toThrow('Invalid tool.tool_mode');
  });

  it('should reject invalid context.compression_strategy', () => {
    expect(() => protoToPolicyConfig({
      context: { compression_strategy: 'aggressive' },
    })).toThrow('Invalid context.compression_strategy');
  });

  it('should pass through absent optional fields', () => {
    const result = protoToPolicyConfig({
      sampling: { temperature: 0.7 },
    });

    expect(result.sampling?.temperature).toBe(0.7);
    expect(result.output).toBeUndefined();
    expect(result.context).toBeUndefined();
    expect(result.tool).toBeUndefined();
    expect(result.reliability).toBeUndefined();
  });
});

// ── authorizeInlinePolicy ────────────────────────────────────────────────────

function mockCall(token?: string): grpc.ServerWritableStream<unknown, unknown> {
  const metadata = new grpc.Metadata();
  if (token) {
    metadata.add('x-abbenay-token', token);
  }
  return { metadata } as unknown as grpc.ServerWritableStream<unknown, unknown>;
}

describe('authorizeInlinePolicy', () => {
  it('should allow when no consumers section (default-open)', () => {
    const result = authorizeInlinePolicy(mockCall(), { providers: {} });
    expect(result.allowed).toBe(true);
  });

  it('should allow when consumers section is empty', () => {
    const result = authorizeInlinePolicy(mockCall(), { providers: {}, consumers: {} });
    expect(result.allowed).toBe(true);
  });

  it('should reject when consumers configured but no token provided', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'secret123';
    try {
      const result = authorizeInlinePolicy(mockCall(), {
        providers: {},
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { inline_policy: true } },
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('x-abbenay-token');
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });

  it('should reject when token does not match any consumer', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'secret123';
    try {
      const result = authorizeInlinePolicy(mockCall('wrong-token'), {
        providers: {},
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { inline_policy: true } },
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not recognized');
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });

  it('should allow when token matches consumer with inline_policy capability', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'secret123';
    try {
      const result = authorizeInlinePolicy(mockCall('secret123'), {
        providers: {},
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { inline_policy: true } },
        },
      });
      expect(result.allowed).toBe(true);
      expect(result.consumer).toBe('apme');
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });

  it('should reject when token matches but consumer lacks inline_policy capability', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'secret123';
    try {
      const result = authorizeInlinePolicy(mockCall('secret123'), {
        providers: {},
        consumers: {
          limited: { token_env: 'TEST_TOKEN', capabilities: {} },
        },
      });
      expect(result.allowed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });
});

// ── authorizeMcpRegister (DR-025) ────────────────────────────────────────────

function mockUnaryCall(token?: string): grpc.ServerUnaryCall<unknown, unknown> {
  const metadata = new grpc.Metadata();
  if (token) {
    metadata.add('x-abbenay-token', token);
  }
  return { metadata } as unknown as grpc.ServerUnaryCall<unknown, unknown>;
}

describe('authorizeMcpRegister', () => {
  it('should allow when no consumers section (default-open)', () => {
    const result = authorizeMcpRegister(mockUnaryCall(), { providers: {} });
    expect(result.allowed).toBe(true);
  });

  it('should reject when consumers exist but no token provided', () => {
    const result = authorizeMcpRegister(mockUnaryCall(), {
      providers: {},
      consumers: {
        apme: { token_env: 'TEST_TOKEN', capabilities: { mcp_register: true } },
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('consumer authentication');
  });

  it('should allow when token matches consumer with mcp_register capability', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'mcp-secret';
    try {
      const result = authorizeMcpRegister(mockUnaryCall('mcp-secret'), {
        providers: {},
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { mcp_register: true } },
        },
      });
      expect(result.allowed).toBe(true);
      expect(result.consumer).toBe('apme');
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });

  it('should reject when token matches but consumer lacks mcp_register capability', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'mcp-secret';
    try {
      const result = authorizeMcpRegister(mockUnaryCall('mcp-secret'), {
        providers: {},
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { inline_policy: true } },
        },
      });
      expect(result.allowed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });

  it('should reject when token does not match any consumer', () => {
    const prev = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = 'mcp-secret';
    try {
      const result = authorizeMcpRegister(mockUnaryCall('wrong-token'), {
        providers: {},
        consumers: {
          apme: { token_env: 'TEST_TOKEN', capabilities: { mcp_register: true } },
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not recognized');
    } finally {
      if (prev === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = prev;
    }
  });
});
