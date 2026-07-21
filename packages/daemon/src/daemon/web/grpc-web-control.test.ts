/**
 * grpc-web-control must use secure credentials for TCP TLS (C2).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import {
  createGrpcWebControlClient,
  grpcWebControlUsesTls,
} from './grpc-web-control.js';
import { createClientCredentials, generateSelfSignedPem } from '../grpc-tls.js';

describe('grpcWebControlUsesTls', () => {
  it('is false for default unix socket (local IPC)', () => {
    expect(grpcWebControlUsesTls()).toBe(false);
    expect(grpcWebControlUsesTls({ address: 'unix:///tmp/abbenay.sock' })).toBe(false);
  });

  it('is false for TCP without tls/caPath (plaintext local DX)', () => {
    expect(grpcWebControlUsesTls({ address: '127.0.0.1:50051' })).toBe(false);
  });

  it('is true for TCP when tls or caPath is set', () => {
    expect(grpcWebControlUsesTls({ address: '127.0.0.1:50051', tls: true })).toBe(true);
    expect(grpcWebControlUsesTls({ address: '10.0.0.1:50051', caPath: '/tmp/ca.crt' })).toBe(true);
  });

  it('stays false for unix even if tls flag is set', () => {
    expect(grpcWebControlUsesTls({
      address: 'unix:///tmp/abbenay.sock',
      tls: true,
      caPath: '/tmp/ca.crt',
    })).toBe(false);
  });
});

describe('createGrpcWebControlClient credentials', () => {
  it('constructs a client for unix (plaintext IPC)', () => {
    const client = createGrpcWebControlClient({
      address: 'unix:///tmp/abbenay-does-not-need-to-exist.sock',
    });
    expect(client).toBeDefined();
    expect(typeof client.close).toBe('function');
    client.close();
  });

  it('constructs a TLS client for TCP with CA path (not createInsecure-only)', () => {
    const { certPem } = generateSelfSignedPem();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-web-ctl-'));
    const caPath = path.join(tmp, 'ca.crt');
    fs.writeFileSync(caPath, certPem);

    try {
      expect(grpcWebControlUsesTls({ address: '127.0.0.1:1', caPath })).toBe(true);
      const client = createGrpcWebControlClient({
        address: '127.0.0.1:1',
        tls: true,
        caPath,
      });
      expect(client).toBeDefined();
      client.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('secure vs insecure credentials', () => {
  it('createClientCredentials returns SSL when TLS requested', () => {
    const { certPem } = generateSelfSignedPem();
    const insecure = grpc.credentials.createInsecure();
    const secure = createClientCredentials({ tls: true, caPem: certPem });
    expect(secure).not.toBe(insecure);
    expect(secure).toBeInstanceOf(grpc.ChannelCredentials);
  });
});
