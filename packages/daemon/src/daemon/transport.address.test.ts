import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseAddressFileContent,
  writeAddressFile,
  readAddressFile,
  removeAddressFile,
  getTransport,
} from './transport.js';
import { getAddressPath, getRuntimeDir } from '../core/paths.js';

describe('parseAddressFileContent', () => {
  it('parses host:port', () => {
    expect(parseAddressFileContent('127.0.0.1:54321\n')).toEqual({
      host: '127.0.0.1',
      port: 54321,
    });
  });

  it('rejects invalid content', () => {
    expect(parseAddressFileContent('')).toBeNull();
    expect(parseAddressFileContent('not-an-address')).toBeNull();
    expect(parseAddressFileContent('127.0.0.1:')).toBeNull();
    expect(parseAddressFileContent(':8080')).toBeNull();
    expect(parseAddressFileContent('127.0.0.1:99999')).toBeNull();
  });
});

describe('address file helpers', () => {
  const originalPlatform = process.platform;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-addr-test-'));
    // Force runtime dir under our temp by setting XDG_RUNTIME_DIR (used on all platforms when set)
    process.env.XDG_RUNTIME_DIR = tmpRoot;
  });

  afterEach(() => {
    removeAddressFile();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env.XDG_RUNTIME_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes, reads, and removes daemon.addr', () => {
    writeAddressFile('127.0.0.1', 41234);
    expect(fs.existsSync(getAddressPath())).toBe(true);
    expect(readAddressFile()).toEqual({ host: '127.0.0.1', port: 41234 });
    removeAddressFile();
    expect(readAddressFile()).toBeNull();
  });

  it('getTransport returns tcp on win32 when address file exists', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    writeAddressFile('127.0.0.1', 45555);
    expect(getTransport()).toEqual({
      type: 'tcp',
      host: '127.0.0.1',
      port: 45555,
    });
  });

  it('getTransport returns unix on non-win32', () => {
    if (process.platform === 'win32') {
      return;
    }
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transport = getTransport();
    expect(transport.type).toBe('unix');
    expect(transport.socketPath).toMatch(/daemon\.sock$/);
    expect(path.dirname(transport.socketPath!)).toBe(getRuntimeDir());
  });
});
