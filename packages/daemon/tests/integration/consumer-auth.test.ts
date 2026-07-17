/**
 * Integration: consumer capability gating on sensitive gRPC RPCs (H8/H10 / DR-037).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, '../../../../proto/abbenay/v1/service.proto');
const PROTO_INCLUDE = path.resolve(__dirname, '../../../../proto');

const TOKEN_ENV = 'ABBENAY_TEST_CONSUMER_TOKEN';
const GOOD_TOKEN = 'integration-consumer-token';

const mockLoadConfig = vi.fn();
const mockLoadWorkspaceConfig = vi.fn().mockReturnValue(null);
const mockMergeConfigs = vi.fn().mockImplementation(
  (user: { providers?: object }) => user || { providers: {} },
);
const mockMergeMultipleWorkspaceConfigs = vi.fn().mockImplementation(
  (base: { providers?: object }) => base || { providers: {} },
);
const mockResolveEngineModelId = vi.fn().mockImplementation(
  (name: string, cfg: { model_id?: string }) => cfg.model_id || name,
);
const mockSaveConfig = vi.fn();

vi.mock('../../src/core/config.js', () => ({
  loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
  loadWorkspaceConfig: (...a: unknown[]) => mockLoadWorkspaceConfig(...a),
  mergeConfigs: (...a: unknown[]) => mockMergeConfigs(...a),
  mergeMultipleWorkspaceConfigs: (...a: unknown[]) => mockMergeMultipleWorkspaceConfigs(...a),
  resolveEngineModelId: (...a: unknown[]) => mockResolveEngineModelId(...a),
  saveConfig: (...a: unknown[]) => mockSaveConfig(...a),
  saveWorkspaceConfig: vi.fn(),
  getUserConfigPath: () => '/tmp/abbenay-test-config.yaml',
  getWorkspaceConfigPath: () => '/tmp/abbenay-test-ws-config.yaml',
  isValidVirtualName: (n: string) => /^[a-z0-9][a-z0-9._-]*$/.test(n),
}));

vi.mock('../../src/core/engines.js', () => ({
  getEngines: () => [
    { id: 'mock', requiresKey: false, supportsTools: false, createModel: () => { throw new Error('mock'); } },
  ],
  getEngine: (id: string) => (id === 'mock' ? { id: 'mock', requiresKey: false } : undefined),
  fetchModels: async () => [],
  streamChat: async function* () { yield { type: 'done', finishReason: 'stop' }; },
  getProviderTemplates: () => [],
}));

const mockSecretStoreData = new Map<string, string>();
vi.mock('../../src/daemon/secrets/keychain.js', () => ({
  KeychainSecretStore: class {
    async get(key: string): Promise<string | null> { return mockSecretStoreData.get(key) ?? null; }
    async set(key: string, value: string): Promise<void> { mockSecretStoreData.set(key, value); }
    async delete(key: string): Promise<boolean> { return mockSecretStoreData.delete(key); }
    async has(key: string): Promise<boolean> { return mockSecretStoreData.has(key); }
  },
}));

let mockSessionsDir: string;
vi.mock('../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/paths.js')>();
  return {
    ...actual,
    getSessionsDir: () => mockSessionsDir,
  };
});

import { DaemonState } from '../../src/daemon/state.js';
import { createAbbenayService } from '../../src/daemon/server/abbenay-service.js';

function loadProto() {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_INCLUDE],
  });
  return grpc.loadPackageDefinition(packageDef);
}

function meta(token?: string): grpc.Metadata {
  const m = new grpc.Metadata();
  if (token) m.add('x-abbenay-token', token);
  return m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callUnary(client: any, method: string, request: object, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, meta(token), (error: grpc.ServiceError | null, response: unknown) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function expectPermissionDenied(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.fail('expected PERMISSION_DENIED');
  } catch (err) {
    const e = err as grpc.ServiceError;
    expect(e.code).toBe(grpc.status.PERMISSION_DENIED);
  }
}

describe('Consumer auth RPC gating', () => {
  let server: grpc.Server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let state: DaemonState;

  beforeAll(async () => {
    process.env[TOKEN_ENV] = GOOD_TOKEN;
    mockSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-consumer-auth-'));

    // Distinct token env per consumer so capability matrix is unambiguous.
    mockLoadConfig.mockReturnValue({
      providers: {},
      consumers: {
        chatter: {
          token_env: 'ABBENAY_TEST_CHAT_TOKEN',
          capabilities: { chat: true },
        },
        secrets_only: {
          token_env: 'ABBENAY_TEST_SECRETS_TOKEN',
          capabilities: { secrets: true },
        },
        config_only: {
          token_env: 'ABBENAY_TEST_CONFIG_TOKEN',
          capabilities: { config: true },
        },
        providers_only: {
          token_env: 'ABBENAY_TEST_PROVIDERS_TOKEN',
          capabilities: { providers: true },
        },
        shutdown_only: {
          token_env: 'ABBENAY_TEST_SHUTDOWN_TOKEN',
          capabilities: { shutdown: true },
        },
        full: {
          token_env: TOKEN_ENV,
          capabilities: {
            chat: true,
            secrets: true,
            config: true,
            providers: true,
            shutdown: true,
            mcp_register: true,
            inline_policy: true,
          },
        },
      },
    });

    process.env.ABBENAY_TEST_CHAT_TOKEN = 'chat-only';
    process.env.ABBENAY_TEST_SECRETS_TOKEN = 'secrets-only';
    process.env.ABBENAY_TEST_CONFIG_TOKEN = 'config-only';
    process.env.ABBENAY_TEST_PROVIDERS_TOKEN = 'providers-only';
    process.env.ABBENAY_TEST_SHUTDOWN_TOKEN = 'shutdown-only';

    state = new DaemonState();
    const proto = loadProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const abbenayProto = (proto as any).abbenay.v1;

    server = new grpc.Server();
    server.addService(abbenayProto.Abbenay.service, createAbbenayService(state));

    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
        if (err) reject(err);
        else resolve(p);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client = new (abbenayProto as any).Abbenay(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(new Date(Date.now() + 5000), (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  afterAll(async () => {
    client?.close();
    await new Promise<void>((resolve) => server?.tryShutdown(() => resolve()));
    fs.rmSync(mockSessionsDir, { recursive: true, force: true });
    delete process.env[TOKEN_ENV];
    delete process.env.ABBENAY_TEST_CHAT_TOKEN;
    delete process.env.ABBENAY_TEST_SECRETS_TOKEN;
    delete process.env.ABBENAY_TEST_CONFIG_TOKEN;
    delete process.env.ABBENAY_TEST_PROVIDERS_TOKEN;
    delete process.env.ABBENAY_TEST_SHUTDOWN_TOKEN;
  });

  afterEach(() => {
    mockSecretStoreData.clear();
  });

  it('denies wrong token on SetSecret', async () => {
    await expectPermissionDenied(callUnary(client, 'SetSecret', { key: 'K', value: 'v' }, 'wrong'));
  });

  it('denies missing token on GetSecret', async () => {
    await expectPermissionDenied(callUnary(client, 'GetSecret', { key: 'K' }));
  });

  it('denies SetSecret without secrets capability', async () => {
    await expectPermissionDenied(callUnary(client, 'SetSecret', { key: 'K', value: 'v' }, 'chat-only'));
  });

  it('allows SetSecret/GetSecret/DeleteSecret with secrets capability', async () => {
    await callUnary(client, 'SetSecret', { key: 'K1', value: 'v1' }, 'secrets-only');
    const got = await callUnary(client, 'GetSecret', { key: 'K1' }, 'secrets-only');
    expect(got.value).toBe('v1');
    await callUnary(client, 'DeleteSecret', { key: 'K1' }, 'secrets-only');
    const missing = await callUnary(client, 'GetSecret', { key: 'K1' }, 'secrets-only');
    expect(missing.value).toBe('');
  });

  it('denies UpdateConfig without config capability', async () => {
    await expectPermissionDenied(callUnary(client, 'UpdateConfig', {
      config: { providers: {} },
    }, 'secrets-only'));
  });

  it('allows UpdateConfig with config capability', async () => {
    await callUnary(client, 'UpdateConfig', {
      config: { providers: {} },
    }, 'config-only');
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it('denies ConfigureProvider without providers capability', async () => {
    await expectPermissionDenied(callUnary(client, 'ConfigureProvider', {
      provider_id: 'p1',
      engine: 'mock',
    }, 'config-only'));
  });

  it('allows ConfigureProvider with providers capability', async () => {
    const res = await callUnary(client, 'ConfigureProvider', {
      provider_id: 'p1',
      engine: 'mock',
    }, 'providers-only');
    expect(res.success).toBe(true);
  });

  it('denies Shutdown without shutdown capability', async () => {
    await expectPermissionDenied(callUnary(client, 'Shutdown', {}, 'chat-only'));
  });

  it('allows HealthCheck without consumer token (ungated)', async () => {
    const res = await callUnary(client, 'HealthCheck', {});
    expect(res.healthy).toBe(true);
  });

  it('full token can call secrets and config', async () => {
    await callUnary(client, 'SetSecret', { key: 'FULL', value: 'ok' }, GOOD_TOKEN);
    await callUnary(client, 'GetConfig', {}, GOOD_TOKEN);
  });

  it('denies SummarizeSession without chat capability', async () => {
    await expectPermissionDenied(callUnary(client, 'SummarizeSession', {
      session_id: 'sess-nope',
    }, 'secrets-only'));
  });

  it('allows SummarizeSession past auth with chat capability', async () => {
    // Capability check runs before session lookup — missing session is not PERMISSION_DENIED.
    try {
      await callUnary(client, 'SummarizeSession', { session_id: 'missing-session' }, 'chat-only');
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      expect(code).not.toBe(grpc.status.PERMISSION_DENIED);
      return;
    }
    // If it somehow succeeds, that also means auth passed.
  });
});

describe('Consumer auth deny-all on non-localhost without consumers', () => {
  let server: grpc.Server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    mockSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-consumer-open-'));
    mockLoadConfig.mockReturnValue({ providers: {} });

    const state = new DaemonState();
    const proto = loadProto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const abbenayProto = (proto as any).abbenay.v1;

    server = new grpc.Server();
    server.addService(
      abbenayProto.Abbenay.service,
      createAbbenayService(state, { loopbackOnly: false, allowOpenAuth: false }),
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
        if (err) reject(err);
        else resolve(p);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client = new (abbenayProto as any).Abbenay(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(new Date(Date.now() + 5000), (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  afterAll(async () => {
    client?.close();
    await new Promise<void>((resolve) => server?.tryShutdown(() => resolve()));
    fs.rmSync(mockSessionsDir, { recursive: true, force: true });
  });

  it('denies SetSecret when serving non-localhost policy without consumers', async () => {
    await expectPermissionDenied(callUnary(client, 'SetSecret', { key: 'K', value: 'v' }));
  });
});
