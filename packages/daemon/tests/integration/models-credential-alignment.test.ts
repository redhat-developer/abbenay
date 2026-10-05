/**
 * Integration: saved provider config vs runtime credential resolution (AAP-93060).
 *
 * Verifies /api/providers configured flag and /api/models availability stay aligned
 * when config references a keychain secret that is not present in the daemon store.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigFile } from '../../src/core/config.js';
import type { EngineInfo } from '../../src/core/engines.js';
import { createWebApp } from '../../src/daemon/web/server.js';
import { DaemonState } from '../../src/daemon/state.js';

const TEST_TOKEN = 'test-models-credential-alignment';

const mockLoadConfig = vi.fn().mockReturnValue({ providers: {} });
const mockLoadWorkspaceConfig = vi.fn().mockReturnValue(null);
const mockMergeConfigs = vi.fn();
const mockMergeMultipleWorkspaceConfigs = vi.fn().mockReturnValue({ providers: {} });

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return {
    ...actual,
    loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
    loadWorkspaceConfig: (...a: unknown[]) => mockLoadWorkspaceConfig(...a),
    mergeConfigs: (...a: unknown[]) => mockMergeConfigs(...a),
    mergeMultipleWorkspaceConfigs: (...a: unknown[]) => mockMergeMultipleWorkspaceConfigs(...a),
  };
});

const OPENROUTER_ENGINE: EngineInfo = {
  id: 'openrouter',
  requiresKey: true,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  defaultEnvVar: 'OPENROUTER_API_KEY',
  supportsTools: true,
  createModel: () => {
    throw new Error('mock');
  },
};

const mockFetchModels = vi.fn().mockResolvedValue([]);

vi.mock('../../src/core/engines.js', () => ({
  getEngines: () => [OPENROUTER_ENGINE],
  getEngine: (id: string) => (id === 'openrouter' ? OPENROUTER_ENGINE : undefined),
  isKnownEngineId: (id: string) => id === 'openrouter',
  validateConfigProviderEngines: () => ({ ok: true as const }),
  fetchModels: (...a: unknown[]) => mockFetchModels(...a),
  streamChat: () => (async function* () {}),
  getProviderTemplates: () => [],
}));

const secretData = new Map<string, string>();

vi.mock('../../src/daemon/secrets/keychain.js', () => ({
  KeychainSecretStore: class {
    async get(key: string) {
      return secretData.get(key) ?? null;
    }
    async set(key: string, value: string) {
      secretData.set(key, value);
    }
    async delete(key: string) {
      return secretData.delete(key);
    }
    async has(key: string) {
      return secretData.has(key);
    }
  },
}));

let sessionsDir: string;
let httpServer: http.Server & { close: (cb?: (err?: Error) => void) => void };
let baseUrl: string;
let daemonState: DaemonState;

const openrouterConfig: ConfigFile = {
  providers: {
    openrouter: {
      engine: 'openrouter',
      api_key_keychain_name: 'OPENROUTER_API_KEY',
      models: {
        'model-a': {},
        'model-b': {},
      },
    },
  },
};

function httpGet(urlPath: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlPath, baseUrl);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, Connection: 'close' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) as Record<string, unknown> });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-models-cred-'));
  daemonState = new DaemonState();
  const app = createWebApp(daemonState, {
    apiToken: TEST_TOKEN,
    skipConfig: true,
    host: '127.0.0.1',
  });

  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

beforeEach(() => {
  secretData.clear();
  mockFetchModels.mockClear();
  mockLoadConfig.mockReturnValue(openrouterConfig);
  mockMergeConfigs.mockReturnValue(openrouterConfig);
  delete process.env.OPENROUTER_API_KEY;
});

describe('models and provider status when API key missing (AAP-93060)', () => {
  it('lists saved models as unavailable and provider configured=false', async () => {
    const providersRes = await httpGet('/api/providers');
    expect(providersRes.statusCode).toBe(200);
    const providers = providersRes.body.providers as Array<{ id: string; configured: boolean }>;
    expect(providers.find((p) => p.id === 'openrouter')?.configured).toBe(false);

    const modelsRes = await httpGet('/api/models');
    expect(modelsRes.statusCode).toBe(200);
    const models = modelsRes.body.models as Array<{
      id: string;
      available: boolean;
      unavailableReason?: string;
    }>;
    expect(models).toHaveLength(2);
    expect(models.every((m) => m.available === false)).toBe(true);
    expect(models[0].unavailableReason).toMatch(/OPENROUTER_API_KEY|keychain/i);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it('marks provider configured and models usable after secret is stored', async () => {
    secretData.set('OPENROUTER_API_KEY', 'sk-test');
    mockFetchModels.mockResolvedValue([
      { id: 'model-a', engine: 'openrouter', contextWindow: 1, capabilities: { supportsTools: true } },
      { id: 'model-b', engine: 'openrouter', contextWindow: 1, capabilities: { supportsTools: true } },
    ]);

    const providersRes = await httpGet('/api/providers');
    const providers = providersRes.body.providers as Array<{ id: string; configured: boolean }>;
    expect(providers.find((p) => p.id === 'openrouter')?.configured).toBe(true);

    const modelsRes = await httpGet('/api/models');
    const models = modelsRes.body.models as Array<{ id: string; available: boolean }>;
    expect(models).toHaveLength(2);
    expect(models.every((m) => m.available !== false)).toBe(true);
    expect(mockFetchModels).toHaveBeenCalled();
  });
});
