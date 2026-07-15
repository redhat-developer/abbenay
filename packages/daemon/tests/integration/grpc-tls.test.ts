/**
 * Integration: gRPC over TLS — sensitive RPCs succeed with matching credentials.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createClientCredentials,
  createTcpServerCredentials,
  generateSelfSignedPem,
  grpcTlsChannelOptions,
  assertTcpBindAllowed,
} from '../../src/daemon/grpc-tls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CI Linux runners have no org.freedesktop.secrets — mock keychain like grpc-real-service.
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

// Imports that construct DaemonState must come after the keychain mock.
import { DaemonState } from '../../src/daemon/state.js';
import { createAbbenayService } from '../../src/daemon/server/abbenay-service.js';

function resolveProto(): { protoFile: string; includeDir: string } {
  const candidates = [
    process.env.ABBENAY_PROTO_DIR,
    path.resolve(__dirname, '../../../../proto'),
    path.resolve(__dirname, '../../../proto'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    const file = path.join(dir, 'abbenay', 'v1', 'service.proto');
    if (fs.existsSync(file)) {
      return { protoFile: file, includeDir: dir };
    }
  }
  throw new Error('Proto file not found for TLS integration test');
}

function callUnary(client: grpc.Client, method: string, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[method](request, (error: Error | null, response: unknown) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

describe('gRPC TLS bind policy (integration scenarios)', () => {
  it('allows TCP gRPC on 127.0.0.1 without TLS (local DX)', () => {
    expect(() =>
      assertTcpBindAllowed('127.0.0.1', { tlsEnabled: false, insecure: false }),
    ).not.toThrow();
  });

  it('refuses bind to 0.0.0.0 without TLS or --insecure', () => {
    expect(() =>
      assertTcpBindAllowed('0.0.0.0', { tlsEnabled: false, insecure: false }),
    ).toThrow(/Refusing to bind gRPC/);
  });

  it('allows 0.0.0.0 with TLS or with --insecure', () => {
    expect(() =>
      assertTcpBindAllowed('0.0.0.0', { tlsEnabled: true, insecure: false }),
    ).not.toThrow();
    expect(() =>
      assertTcpBindAllowed('0.0.0.0', { tlsEnabled: false, insecure: true }),
    ).not.toThrow();
  });
});

describe('gRPC TLS handshake + SetSecret/GetSecret', () => {
  let server: grpc.Server;
  let client: grpc.Client;
  let address: string;
  let tmpDir: string;
  let sessionsDir: string;
  let certPem: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AbbenayCtor: any;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-grpc-tls-'));
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-grpc-tls-sessions-'));
    process.env.ABBENAY_SESSIONS_DIR = sessionsDir;

    const generated = generateSelfSignedPem();
    certPem = generated.certPem;
    const certPath = path.join(tmpDir, 'server.crt');
    const keyPath = path.join(tmpDir, 'server.key');
    fs.writeFileSync(certPath, certPem);
    fs.writeFileSync(keyPath, generated.keyPem);

    const resolved = createTcpServerCredentials({
      enabled: true,
      certPath,
      keyPath,
      caPath: certPath,
    });
    expect(resolved.tlsEnabled).toBe(true);

    assertTcpBindAllowed('0.0.0.0', {
      tlsEnabled: resolved.tlsEnabled,
      insecure: false,
    });

    const { protoFile, includeDir } = resolveProto();
    const packageDef = protoLoader.loadSync(protoFile, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [includeDir],
    });
    const proto = grpc.loadPackageDefinition(packageDef);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const abbenayProto = (proto as any).abbenay.v1;
    AbbenayCtor = abbenayProto.Abbenay;

    const state = new DaemonState();
    server = new grpc.Server();
    server.addService(abbenayProto.Abbenay.service, createAbbenayService(state));

    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', resolved.serverCredentials, (err, p) => {
        if (err) reject(err);
        else resolve(p);
      });
    });

    address = `127.0.0.1:${port}`;
    const creds = createClientCredentials({ tls: true, caPem: certPem });
    client = new AbbenayCtor(address, creds, grpcTlsChannelOptions());

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.ABBENAY_SESSIONS_DIR;
  });

  it('completes SetSecret/GetSecret over TLS', async () => {
    const key = `tls-test-key-${Date.now()}`;
    const value = 'super-secret-value';

    await callUnary(client, 'SetSecret', { key, value });
    const got = await callUnary(client, 'GetSecret', { key }) as { value: string };

    expect(got.value).toBe(value);
  });

  it('rejects plaintext client against TLS server', async () => {
    const insecureClient = new AbbenayCtor(address, grpc.credentials.createInsecure());
    await expect(callUnary(insecureClient, 'HealthCheck', {})).rejects.toBeTruthy();
    insecureClient.close();
  });
});
