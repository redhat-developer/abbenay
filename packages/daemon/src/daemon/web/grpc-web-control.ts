/**
 * Thin gRPC client used ONLY by `abbenay web` CLI (Case A)
 * to send StartWebServer / StopWebServer to an already-running daemon.
 *
 * This is NOT used by the web dashboard itself — the dashboard
 * calls DaemonState directly (no gRPC in the loop).
 *
 * Default transport is the local Unix socket (plaintext IPC).
 * TCP + TLS is supported when address/tls options are provided
 * (e.g. controlling a remote daemon).
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDefaultSocketPath } from '../transport.js';
import {
  createClientCredentials,
  grpcTlsChannelOptions,
  GRPC_TLS_DEFAULT_CN,
} from '../grpc-tls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve proto directory. Checks:
 *  1) ABBENAY_PROTO_DIR env var
 *  2) Next to parent dir: __dirname/../proto/  (esbuild bundle, __dirname is web/)
 *  3) __dirname/proto/ (flat bundle)
 *  4) Monorepo layout: __dirname/../../../../proto/  (development from dist/web/)
 */
function resolveProtoDir(): string {
  const candidates = [
    process.env.ABBENAY_PROTO_DIR,
    path.resolve(__dirname, '../proto'),
    path.resolve(__dirname, 'proto'),
    path.resolve(__dirname, '../../../../../proto'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'abbenay', 'v1', 'service.proto'))) {
      return dir;
    }
  }
  throw new Error(`Proto file not found in any candidate directory`);
}

const PROTO_DIR = resolveProtoDir();
const PROTO_PATH = path.join(PROTO_DIR, 'abbenay', 'v1', 'service.proto');

interface AbbenayGrpcClient {
  StartWebServer(request: { port: number }, callback: (err: Error | null, response: StartWebServerResponse) => void): void;
  StopWebServer(request: object, callback: (err: Error | null, response: object) => void): void;
  close(): void;
}

interface StartWebServerResponse {
  started: boolean;
  already_running: boolean;
  port: number;
  url: string;
}

interface GrpcProto {
  abbenay: { v1: { Abbenay: new (address: string, creds: grpc.ChannelCredentials, options?: object) => AbbenayGrpcClient } };
}

export interface GrpcWebControlOptions {
  /** gRPC target. Defaults to unix://<default-socket>. */
  address?: string;
  /** Enable TLS (required for non-local TCP when the daemon uses --grpc-tls). */
  tls?: boolean;
  /** Path to CA / trust PEM matching the daemon's cert. */
  caPath?: string;
  /** Override SSL target name (default: abbenay-grpc for auto-generated certs). */
  sslTargetNameOverride?: string;
}

function createClient(opts: GrpcWebControlOptions = {}): AbbenayGrpcClient {
  const address = opts.address ?? `unix://${getDefaultSocketPath()}`;
  const useTls = !!opts.tls || !!opts.caPath;
  // Unix sockets stay plaintext; TLS only applies to TCP targets.
  const isUnix = address.startsWith('unix:');
  const credentials = createClientCredentials({
    tls: !isUnix && useTls,
    caPath: opts.caPath,
  });

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });

  const proto = grpc.loadPackageDefinition(packageDef) as unknown as GrpcProto;
  const channelOptions = (!isUnix && useTls)
    ? grpcTlsChannelOptions(opts.sslTargetNameOverride ?? GRPC_TLS_DEFAULT_CN)
    : undefined;

  return new proto.abbenay.v1.Abbenay(
    address,
    credentials,
    channelOptions,
  );
}

/** @internal Exported for tests — builds the same client as Start/StopWebServer. */
export function createGrpcWebControlClient(opts?: GrpcWebControlOptions): AbbenayGrpcClient {
  return createClient(opts);
}

/**
 * Whether the given control options will use TLS channel credentials.
 * Unix targets are always plaintext; TCP uses TLS when tls/caPath is set.
 */
export function grpcWebControlUsesTls(opts: GrpcWebControlOptions = {}): boolean {
  const address = opts.address ?? `unix://${getDefaultSocketPath()}`;
  if (address.startsWith('unix:')) {
    return false;
  }
  return !!opts.tls || !!opts.caPath;
}

function callUnary<T>(client: AbbenayGrpcClient, method: string, request: object): Promise<T> {
  return new Promise((resolve, reject) => {
    (client as unknown as Record<string, (req: object, cb: (err: Error | null, res: T) => void) => void>)[method](request, (error: Error | null, response: T) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

/**
 * Send StartWebServer gRPC to an already-running daemon.
 */
export async function sendStartWebServer(port: number, opts?: GrpcWebControlOptions): Promise<{
  started: boolean;
  already_running: boolean;
  port: number;
  url: string;
}> {
  const client = createClient(opts);
  try {
    const result = await callUnary<StartWebServerResponse>(client, 'StartWebServer', { port });
    return result;
  } finally {
    client.close();
  }
}

/**
 * Send StopWebServer gRPC to an already-running daemon.
 */
export async function sendStopWebServer(opts?: GrpcWebControlOptions): Promise<void> {
  const client = createClient(opts);
  try {
    await callUnary(client, 'StopWebServer', {});
  } finally {
    client.close();
  }
}
