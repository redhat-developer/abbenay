/**
 * gRPC integration tests against the real createAbbenayService.
 *
 * Unlike grpc-streaming.test.ts (which uses a mock server with hardcoded
 * responses), these tests wire createAbbenayService + DaemonState + a
 * proto-loader gRPC client together, exercising the actual RPC handlers.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// ── Mocks (same pattern as state.test.ts) ──────────────────────────────────

const mockLoadConfig = vi.fn().mockReturnValue({ providers: {} });
const mockLoadWorkspaceConfig = vi.fn().mockReturnValue(null);
const mockMergeConfigs = vi.fn().mockImplementation(
  (user: { providers?: object }, _ws: unknown) => user || { providers: {} },
);
const mockMergeMultipleWorkspaceConfigs = vi.fn().mockImplementation(
  (base: { providers?: object }) => base || { providers: {} },
);
const mockResolveEngineModelId = vi.fn().mockImplementation(
  (name: string, cfg: { model_id?: string }) => cfg.model_id || name,
);

vi.mock('../../src/core/config.js', () => ({
  loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
  loadWorkspaceConfig: (...a: unknown[]) => mockLoadWorkspaceConfig(...a),
  mergeConfigs: (...a: unknown[]) => mockMergeConfigs(...a),
  mergeMultipleWorkspaceConfigs: (...a: unknown[]) => mockMergeMultipleWorkspaceConfigs(...a),
  resolveEngineModelId: (...a: unknown[]) => mockResolveEngineModelId(...a),
}));

const mockGetEngines = vi.fn().mockReturnValue([
  { id: 'mock', requiresKey: false, supportsTools: false, createModel: () => { throw new Error('mock'); } },
]);
const mockGetEngine = vi.fn().mockImplementation((id: string) => {
  if (id === 'mock') return { id: 'mock', requiresKey: false, supportsTools: false };
  return undefined;
});
const mockFetchModels = vi.fn().mockResolvedValue([]);
const mockStreamChat = vi.fn();

vi.mock('../../src/core/engines.js', () => ({
  getEngines: (...a: unknown[]) => mockGetEngines(...a),
  getEngine: (...a: unknown[]) => mockGetEngine(...a),
  fetchModels: (...a: unknown[]) => mockFetchModels(...a),
  streamChat: (...a: unknown[]) => mockStreamChat(...a),
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

afterEach(() => {
  mockSecretStoreData.clear();
});

let mockSessionsDir: string;
vi.mock('../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/paths.js')>();
  return {
    ...actual,
    getSessionsDir: () => mockSessionsDir,
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { DaemonState } from '../../src/daemon/state.js';
import { createAbbenayService } from '../../src/daemon/server/abbenay-service.js';

// ── Test helpers ───────────────────────────────────────────────────────────

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callUnary(client: any, method: string, request: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, (error: grpc.ServiceError | null, response: unknown) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectStream(client: any, method: string, request: object): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    const stream = client[method](request);
    stream.on('data', (data: unknown) => chunks.push(data));
    stream.on('error', reject);
    stream.on('end', () => resolve(chunks));
  });
}

// ── Server lifecycle ───────────────────────────────────────────────────────

let server: grpc.Server;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let state: DaemonState;
let address: string;

beforeAll(async () => {
  mockSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-grpc-test-sessions-'));

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

  address = `127.0.0.1:${port}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client = new (abbenayProto as any).Abbenay(address, grpc.credentials.createInsecure());

  await new Promise<void>((resolve, reject) => {
    const deadline = new Date(Date.now() + 5000);
    client.waitForReady(deadline, (err: Error | null) => {
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Real gRPC service: Register / Unregister', () => {
  it('should register a CLI client and return a client_id', async () => {
    const res = await callUnary(client, 'Register', {
      client: { client_type: 'CLIENT_TYPE_CLI' },
    });
    expect(res.client_id).toBeTruthy();
    expect(typeof res.client_id).toBe('string');
    expect(res.connected_clients).toBeGreaterThanOrEqual(1);
  });

  it('should unregister a previously registered client', async () => {
    const reg = await callUnary(client, 'Register', {
      client: { client_type: 'CLIENT_TYPE_CLI' },
    });
    const res = await callUnary(client, 'Unregister', { client_id: reg.client_id });
    expect(res).toBeDefined();
  });
});

describe('Real gRPC service: HealthCheck', () => {
  it('should return healthy with version', async () => {
    const res = await callUnary(client, 'HealthCheck', {});
    expect(res.healthy).toBe(true);
    expect(res.version).toBeTruthy();
  });
});

describe('Real gRPC service: GetStatus', () => {
  it('should return daemon status with version and timestamp', async () => {
    const res = await callUnary(client, 'GetStatus', {});
    expect(res.version).toBeTruthy();
    expect(res.started_at).toBeDefined();
  });
});

describe('Real gRPC service: ListProviders', () => {
  it('should list configured providers', async () => {
    const testConfig = {
      providers: {
        mock: { engine: 'mock', models: {} },
      },
    };
    mockLoadConfig.mockReturnValue(testConfig);
    const res = await callUnary(client, 'ListProviders', {});
    expect(res.providers).toBeDefined();
    expect(Array.isArray(res.providers)).toBe(true);
    expect(res.providers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Real gRPC service: ListModels', () => {
  it('should list models from config', async () => {
    const testConfig = {
      providers: {
        mock: { engine: 'mock', models: { 'my-model': { model_id: 'mock-echo' } } },
      },
    };
    mockLoadConfig.mockReturnValue(testConfig);
    const res = await callUnary(client, 'ListModels', {});
    expect(res.models).toBeDefined();
    expect(Array.isArray(res.models)).toBe(true);
  });
});

describe('Real gRPC service: ListEngines', () => {
  it('should return available engines', async () => {
    const res = await callUnary(client, 'ListEngines', {});
    expect(res.engines).toBeDefined();
    expect(Array.isArray(res.engines)).toBe(true);
    expect(res.engines.length).toBeGreaterThanOrEqual(1);
    expect(res.engines[0].id).toBe('mock');
  });
});

describe('Real gRPC service: Secrets', () => {
  it('should set and get a secret', async () => {
    await callUnary(client, 'SetSecret', { key: 'TEST_KEY', value: 'test-value' });
    const res = await callUnary(client, 'GetSecret', { key: 'TEST_KEY' });
    expect(res.value).toBe('test-value');
  });

  it('should return empty value for missing secret', async () => {
    const res = await callUnary(client, 'GetSecret', { key: 'NONEXISTENT' });
    expect(res.value).toBe('');
  });

  it('should delete a secret', async () => {
    await callUnary(client, 'SetSecret', { key: 'DEL_KEY', value: 'x' });
    await callUnary(client, 'DeleteSecret', { key: 'DEL_KEY' });
    const res = await callUnary(client, 'GetSecret', { key: 'DEL_KEY' });
    expect(res.value).toBe('');
  });

  it('should list secrets (engine key names)', async () => {
    const res = await callUnary(client, 'ListSecrets', {});
    expect(res.secrets).toBeDefined();
    expect(Array.isArray(res.secrets)).toBe(true);
  });
});

describe('Real gRPC service: Chat streaming', () => {
  it('should stream text chunks from mock engine', async () => {
    const testConfig = {
      providers: {
        mock: { engine: 'mock', models: { echo: { model_id: 'echo' } } },
      },
    };
    mockLoadConfig.mockReturnValue(testConfig);

    async function* fakeStream() {
      yield { type: 'text' as const, text: 'Hello' };
      yield { type: 'text' as const, text: ' world' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }
    mockStreamChat.mockReturnValue(fakeStream());

    const chunks = await collectStream(client, 'Chat', {
      model: 'mock/echo',
      messages: [{ role: 2, content: 'test' }],
    });

    const textChunks = chunks.filter((c: Record<string, unknown>) => c.text);
    expect(textChunks.length).toBeGreaterThanOrEqual(1);

    const doneChunks = chunks.filter((c: Record<string, unknown>) => c.done);
    expect(doneChunks.length).toBe(1);
  });

  it('should return error for unknown provider', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });

    const chunks = await collectStream(client, 'Chat', {
      model: 'nonexistent/model',
      messages: [{ role: 2, content: 'test' }],
    });

    const errorChunks = chunks.filter((c: Record<string, unknown>) => c.error);
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Real gRPC service: Sessions', () => {
  it('should create and retrieve a session', async () => {
    const created = await callUnary(client, 'CreateSession', {
      topic: 'Test Session',
      model: 'mock/echo',
    });
    expect(created.id).toBeTruthy();
    expect(created.topic).toBe('Test Session');

    const fetched = await callUnary(client, 'GetSession', { session_id: created.id });
    expect(fetched.id).toBe(created.id);
    expect(fetched.topic).toBe('Test Session');
  });

  it('should list sessions', async () => {
    const res = await callUnary(client, 'ListSessions', {});
    expect(res.sessions).toBeDefined();
    expect(Array.isArray(res.sessions)).toBe(true);
  });

  it('should delete a session', async () => {
    const created = await callUnary(client, 'CreateSession', {
      topic: 'To Delete',
      model: 'mock/echo',
    });
    await callUnary(client, 'DeleteSession', { session_id: created.id });

    try {
      await callUnary(client, 'GetSession', { session_id: created.id });
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      expect((err as grpc.ServiceError).code).toBe(grpc.status.NOT_FOUND);
    }
  });
});

describe('Real gRPC service: Policies', () => {
  it('should list built-in policies', async () => {
    const res = await callUnary(client, 'ListPolicies', {});
    expect(res.policies).toBeDefined();
    expect(res.policies.length).toBeGreaterThanOrEqual(1);
    const precise = res.policies.find((p: { name: string }) => p.name === 'precise');
    expect(precise).toBeDefined();
    expect(precise.builtin).toBe(true);
  });
});

describe('Real gRPC service: ListTools', () => {
  it('should return an empty tool list when no MCP servers', async () => {
    const res = await callUnary(client, 'ListTools', {});
    expect(res.tools).toBeDefined();
    expect(Array.isArray(res.tools)).toBe(true);
  });
});
