/**
 * Config loader unit tests
 *
 * Tests loadConfigFromPath, mergeConfigs, mergeMultipleWorkspaceConfigs,
 * isValidVirtualName, and old-to-new schema migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';

// Mock the paths module so loadConfig/loadWorkspaceConfig read from our temp dirs
let mockUserConfigPath = '/tmp/nonexistent-user-config.yaml';
vi.mock('./paths.js', () => ({
  getUserConfigPath: () => mockUserConfigPath,
  getWorkspaceConfigPath: (wsPath: string) => path.join(wsPath, '.config', 'abbenay', 'config.yaml'),
}));

import {
  loadConfigFromPath,
  mergeConfigs,
  mergeMultipleWorkspaceConfigs,
  isValidVirtualName,
  resolveEngineModelId,
  type ConfigFile,
  type ModelConfig,
} from './config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(filePath: string, data: any): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, yaml.dump(data));
  return filePath;
}

function setUserConfig(data: any): void {
  mockUserConfigPath = path.join(tmpDir, 'user-config.yaml');
  writeYaml(mockUserConfigPath, data);
}

function createWorkspace(name: string, data: any): string {
  const wsDir = path.join(tmpDir, name);
  writeYaml(path.join(wsDir, '.config', 'abbenay', 'config.yaml'), data);
  return wsDir;
}

// ── isValidVirtualName ────────────────────────────────────────────────────────

describe('isValidVirtualName', () => {
  it('should accept simple lowercase names', () => {
    expect(isValidVirtualName('openrouter')).toBe(true);
    expect(isValidVirtualName('openai')).toBe(true);
    expect(isValidVirtualName('my-provider')).toBe(true);
    expect(isValidVirtualName('work.openrouter')).toBe(true);
    expect(isValidVirtualName('my_provider_2')).toBe(true);
  });

  it('should reject names with slashes', () => {
    expect(isValidVirtualName('openrouter/anthropic')).toBe(false);
  });

  it('should reject names with spaces', () => {
    expect(isValidVirtualName('my provider')).toBe(false);
  });

  it('should reject names starting with non-alphanumeric', () => {
    expect(isValidVirtualName('-bad')).toBe(false);
    expect(isValidVirtualName('.bad')).toBe(false);
    expect(isValidVirtualName('_bad')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidVirtualName('')).toBe(false);
  });

  it('should accept single character', () => {
    expect(isValidVirtualName('a')).toBe(true);
    expect(isValidVirtualName('1')).toBe(true);
  });
});

// ── resolveEngineModelId ──────────────────────────────────────────────────────

describe('resolveEngineModelId', () => {
  it('should return model_id when present', () => {
    expect(resolveEngineModelId('claude-precise', { model_id: 'anthropic/claude-opus-4.6' })).toBe('anthropic/claude-opus-4.6');
  });

  it('should return the name when no model_id', () => {
    expect(resolveEngineModelId('openrouter/anthropic/claude-opus-4.6', {})).toBe('openrouter/anthropic/claude-opus-4.6');
  });
});

// ── loadConfigFromPath (new schema) ──────────────────────────────────────────

describe('loadConfigFromPath (new schema)', () => {
  it('should parse new-format config with engine and models map', () => {
    const filePath = writeYaml(path.join(tmpDir, 'config.yaml'), {
      providers: {
        'work-openrouter': {
          engine: 'openrouter',
          api_key_keychain_name: 'OPENROUTER_WORK_KEY',
          models: {
            'openrouter/anthropic/claude-haiku-3.5': {},
            'claude-precise': {
              model_id: 'openrouter/anthropic/claude-opus-4.6',
              temperature: 0.2,
              top_p: 0.5,
            },
          },
        },
      },
    });

    const config = loadConfigFromPath(filePath);

    expect(config).not.toBeNull();
    const prov = config!.providers!['work-openrouter'];
    expect(prov).toBeDefined();
    expect(prov.engine).toBe('openrouter');
    expect(prov.models).toBeDefined();
    expect(Object.keys(prov.models!)).toHaveLength(2);
    expect(prov.models!['claude-precise'].model_id).toBe('openrouter/anthropic/claude-opus-4.6');
    expect(prov.models!['claude-precise'].temperature).toBe(0.2);
  });

  it('should return { providers: {} } for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.yaml');
    fs.writeFileSync(filePath, '');
    expect(loadConfigFromPath(filePath)).toEqual({ providers: {} });
  });

  it('should return null for missing file', () => {
    expect(loadConfigFromPath(path.join(tmpDir, 'nonexistent.yaml'))).toBeNull();
  });

  it('should reject old array-based providers format', () => {
    const filePath = writeYaml(path.join(tmpDir, 'old.yaml'), {
      providers: [{ name: 'openai', api_key: 'sk-123' }],
    });
    expect(loadConfigFromPath(filePath)).toEqual({ providers: {} });
  });
});

// ── loadConfigFromPath (old schema migration) ────────────────────────────────

describe('loadConfigFromPath (old schema migration)', () => {
  it('should migrate enabled_models to models map', () => {
    const filePath = writeYaml(path.join(tmpDir, 'old-config.yaml'), {
      providers: {
        openrouter: {
          enabled_models: ['openrouter/anthropic/claude-opus-4.5', 'openrouter/anthropic/claude-opus-4.6'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const config = loadConfigFromPath(filePath);

    expect(config).not.toBeNull();
    const prov = config!.providers!.openrouter;
    expect(prov.engine).toBe('openrouter');
    expect(prov.models).toBeDefined();
    expect(Object.keys(prov.models!)).toHaveLength(2);
    expect(prov.models!['openrouter/anthropic/claude-opus-4.5']).toEqual({});
    expect(prov.models!['openrouter/anthropic/claude-opus-4.6']).toEqual({});
    expect((prov as any).enabled_models).toBeUndefined();
  });

  it('should migrate api_base to base_url', () => {
    const filePath = writeYaml(path.join(tmpDir, 'old-base.yaml'), {
      providers: {
        openai: {
          api_base: 'https://custom.openai.com',
          api_key_keychain_name: 'OPENAI_API_KEY',
        },
      },
    });

    const config = loadConfigFromPath(filePath);

    const prov = config!.providers!.openai;
    expect(prov.base_url).toBe('https://custom.openai.com');
    expect((prov as any).api_base).toBeUndefined();
  });
});

// ── mergeConfigs ─────────────────────────────────────────────────────────────

describe('mergeConfigs', () => {
  it('should return user config when workspace is null', () => {
    const userConfig: ConfigFile = {
      providers: {
        openrouter: { engine: 'openrouter', api_key_keychain_name: 'KEY' },
      },
    };
    expect(mergeConfigs(userConfig, null)).toBe(userConfig);
  });

  it('should completely replace provider when workspace defines it', () => {
    const userConfig: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'USER_KEY',
          models: { 'model-a': {}, 'model-b': {}, 'model-c': {} },
        },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'WS_KEY',
          models: { 'model-a': {} },
        },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    expect(result.providers!.openrouter.api_key_keychain_name).toBe('WS_KEY');
    expect(Object.keys(result.providers!.openrouter.models!)).toEqual(['model-a']);
  });

  it('should preserve user-only providers untouched', () => {
    const userConfig: ConfigFile = {
      providers: {
        openai: { engine: 'openai', api_key_keychain_name: 'OPENAI_KEY' },
        anthropic: { engine: 'anthropic', api_key_keychain_name: 'ANTHROPIC_KEY' },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        openai: { engine: 'openai', base_url: 'https://ws.openai.com' },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    expect(result.providers!.anthropic).toBeDefined();
    expect(result.providers!.anthropic.api_key_keychain_name).toBe('ANTHROPIC_KEY');
  });

  it('should add workspace-only providers', () => {
    const userConfig: ConfigFile = {
      providers: {
        openai: { engine: 'openai', api_key_keychain_name: 'KEY' },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        ollama: { engine: 'ollama', base_url: 'http://localhost:11434' },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    expect(result.providers!.openai).toBeDefined();
    expect(result.providers!.ollama).toBeDefined();
    expect(result.providers!.ollama.engine).toBe('ollama');
  });
});

// ── mergeMultipleWorkspaceConfigs ────────────────────────────────────────────

describe('mergeMultipleWorkspaceConfigs', () => {
  it('should return user config unchanged when no workspace paths', () => {
    setUserConfig({
      providers: {
        openrouter: {
          engine: 'openrouter',
          models: { 'model-a': {}, 'model-b': {} },
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([]);

    expect(Object.keys(result.providers!.openrouter.models!)).toEqual(['model-a', 'model-b']);
  });

  it('should use workspace models (provider-level replacement)', () => {
    setUserConfig({
      providers: {
        openrouter: {
          engine: 'openrouter',
          models: { 'model-a': {}, 'model-b': {}, 'model-c': {} },
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const wsDir = createWorkspace('ws', {
      providers: {
        openrouter: {
          engine: 'openrouter',
          models: { 'model-a': {} },
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(Object.keys(result.providers!.openrouter.models!)).toEqual(['model-a']);
  });

  it('should preserve user-only providers untouched', () => {
    setUserConfig({
      providers: {
        openrouter: { engine: 'openrouter', models: { 'model-a': {} }, api_key_keychain_name: 'OR_KEY' },
        openai: { engine: 'openai', api_key_keychain_name: 'OAI_KEY' },
      },
    });

    const wsDir = createWorkspace('ws', {
      providers: {
        openrouter: { engine: 'openrouter', models: { 'model-b': {} }, api_key_keychain_name: 'OR_KEY' },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(result.providers!.openai).toBeDefined();
    expect(result.providers!.openai.api_key_keychain_name).toBe('OAI_KEY');
  });

  it('should union models across multiple workspaces', () => {
    setUserConfig({
      providers: {
        openrouter: { engine: 'openrouter', api_key_keychain_name: 'KEY' },
      },
    });

    const ws1 = createWorkspace('ws1', {
      providers: {
        openrouter: { engine: 'openrouter', models: { 'model-a': {} }, api_key_keychain_name: 'KEY' },
      },
    });

    const ws2 = createWorkspace('ws2', {
      providers: {
        openrouter: { engine: 'openrouter', models: { 'model-b': {} }, api_key_keychain_name: 'KEY' },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([ws1, ws2]);

    const models = Object.keys(result.providers!.openrouter.models!);
    expect(models).toContain('model-a');
    expect(models).toContain('model-b');
    expect(models).toHaveLength(2);
  });

  it('should handle workspace with no config file gracefully', () => {
    setUserConfig({
      providers: {
        openrouter: { engine: 'openrouter', models: { 'model-a': {} }, api_key_keychain_name: 'KEY' },
      },
    });

    const wsDir = path.join(tmpDir, 'empty-ws');
    fs.mkdirSync(wsDir, { recursive: true });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(Object.keys(result.providers!.openrouter.models!)).toEqual(['model-a']);
  });

  it('should handle old-format workspace configs via migration', () => {
    setUserConfig({
      providers: {
        openrouter: { engine: 'openrouter', models: {}, api_key_keychain_name: 'KEY' },
      },
    });

    const wsDir = createWorkspace('ws-old', {
      providers: {
        openrouter: {
          enabled_models: ['openrouter/anthropic/claude-opus-4.5'],
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(result.providers!.openrouter.models).toBeDefined();
    expect(result.providers!.openrouter.models!['openrouter/anthropic/claude-opus-4.5']).toEqual({});
  });
});

// ── ModelConfig params ───────────────────────────────────────────────────────

describe('ModelConfig', () => {
  it('should parse all model parameters from YAML', () => {
    const filePath = writeYaml(path.join(tmpDir, 'params.yaml'), {
      providers: {
        'my-provider': {
          engine: 'openrouter',
          models: {
            'custom-model': {
              model_id: 'openrouter/anthropic/claude-opus-4.6',
              temperature: 0.3,
              top_p: 0.8,
              top_k: 50,
              max_tokens: 4096,
              timeout: 30000,
              system_prompt: 'You are a helpful assistant.',
              system_prompt_mode: 'prepend',
            },
          },
        },
      },
    });

    const config = loadConfigFromPath(filePath);
    const model = config!.providers!['my-provider'].models!['custom-model'];

    expect(model.model_id).toBe('openrouter/anthropic/claude-opus-4.6');
    expect(model.temperature).toBe(0.3);
    expect(model.top_p).toBe(0.8);
    expect(model.top_k).toBe(50);
    expect(model.max_tokens).toBe(4096);
    expect(model.timeout).toBe(30000);
    expect(model.system_prompt).toBe('You are a helpful assistant.');
    expect(model.system_prompt_mode).toBe('prepend');
  });
});
