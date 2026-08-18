/**
 * transport.ts unit tests
 *
 * - address file parsing and helpers
 * - PID/socket lifecycle helpers
 * - isDaemonRunning async probes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as transport from './transport.js';

import {
  parseAddressFileContent,
  writeAddressFile,
  readAddressFile,
  removeAddressFile,
  getTransport,
  getDefaultSocketPath,
  getPidFilePath,
  ensureSocketDir,
  ensureRuntimeDir,
  cleanupSocket,
  cleanupIpcArtifacts,
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessRunning,
  isDaemonRunningSync,
  isDaemonRunning,
  probeTcpAddress,
  killDaemon,
} from './transport.js';
import { getAddressPath, getRuntimeDir, getSocketPath } from '../core/paths.js';

/** isDaemonRunning is sync for PID/win32; unix socket path returns a Promise at runtime. */
async function expectDaemonRunning(expected: boolean): Promise<void> {
  const result = isDaemonRunning() as unknown as boolean | Promise<boolean>;
  const value = await Promise.resolve(result);
  expect(value).toBe(expected);
}

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

  it('getTransport returns unix on non-win32', (context) => {
    if (process.platform === 'win32') {
      context.skip(); return;
    }
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const info = getTransport();
    expect(info.type).toBe('unix');
    expect(info.socketPath).toMatch(/daemon\.sock$/);
    expect(path.dirname(info.socketPath!)).toBe(getRuntimeDir());
  });
});

describe('transport lifecycle helpers', () => {
  const originalPlatform = process.platform;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-transport-test-'));
    process.env.XDG_RUNTIME_DIR = tmpRoot;
    cleanupIpcArtifacts();
    removePidFile();
  });

  afterEach(() => {
    cleanupIpcArtifacts();
    removePidFile();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env.XDG_RUNTIME_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('getDefaultSocketPath and getPidFilePath use runtime dir', () => {
    expect(getDefaultSocketPath()).toBe(getSocketPath());
    expect(getPidFilePath()).toContain(getRuntimeDir());
  });

  it('ensureRuntimeDir creates runtime directory', () => {
    const runtimeDir = getRuntimeDir();
    if (fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
    ensureRuntimeDir();
    expect(fs.existsSync(runtimeDir)).toBe(true);
  });

  it('ensureSocketDir creates parent dir on unix', (context) => {
    if (process.platform === 'win32') { context.skip(); return; }
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const socketDir = path.dirname(getSocketPath());
    if (fs.existsSync(socketDir)) {
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
    ensureSocketDir();
    expect(fs.existsSync(socketDir)).toBe(true);
  });

  it('writePidFile / readPidFile round-trip', () => {
    writePidFile();
    expect(readPidFile()).toBe(process.pid);
    removePidFile();
    expect(readPidFile()).toBeNull();
  });

  it('isProcessRunning reflects current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    expect(isProcessRunning(999999999)).toBe(false);
  });

  it('isDaemonRunningSync returns true when PID file matches live process', () => {
    writePidFile();
    expect(isDaemonRunningSync()).toBe(true);
  });

  it('isDaemonRunningSync cleans stale PID and IPC artifacts', () => {
    ensureRuntimeDir();
    fs.writeFileSync(getPidFilePath(), '999999999', { mode: 0o600 });
    const socketPath = getSocketPath();
    if (process.platform !== 'win32') {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      ensureSocketDir();
      fs.writeFileSync(socketPath, '');
    }

    expect(isDaemonRunningSync()).toBe(false);
    expect(readPidFile()).toBeNull();
    if (process.platform !== 'win32') {
      expect(fs.existsSync(socketPath)).toBe(false);
    }
  });

  it('cleanupSocket removes unix socket file', (context) => {
    if (process.platform === 'win32') { context.skip(); return; }
    Object.defineProperty(process, 'platform', { value: 'linux' });
    ensureSocketDir();
    const socketPath = getSocketPath();
    fs.writeFileSync(socketPath, '');
    cleanupSocket();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('probeTcpAddress succeeds on listening port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probeTcpAddress('127.0.0.1', port, 2000)).toBe(true);
    server.close();
  });

  it('probeTcpAddress fails on closed port', async () => {
    expect(await probeTcpAddress('127.0.0.1', 1, 200)).toBe(false);
  });

  it('getTransport on win32 without address file uses defaults', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const info = getTransport();
    expect(info.type).toBe('tcp');
    expect(info.host).toBe('127.0.0.1');
    expect(info.port).toBeUndefined();
  });

  it('killDaemon returns false when no PID file exists', () => {
    expect(killDaemon()).toBe(false);
  });

  it('ensureSocketDir on win32 delegates to ensureRuntimeDir', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const runtimeDir = getRuntimeDir();
    if (fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
    ensureSocketDir();
    expect(fs.existsSync(runtimeDir)).toBe(true);
  });

  it('cleanupSocket is no-op on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => cleanupSocket()).not.toThrow();
  });

  it('killDaemon escalates to SIGKILL when process lingers', () => {
    writePidFile();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let runningChecks = 0;
    const runningSpy = vi.spyOn(transport, 'isProcessRunning').mockImplementation(() => {
      runningChecks += 1;
      return runningChecks < 3;
    });
    expect(killDaemon()).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    killSpy.mockRestore();
    runningSpy.mockRestore();
    removePidFile();
  });

  it('getTransport reads address file on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    writeAddressFile('127.0.0.1', 55555);
    const info = getTransport();
    expect(info.type).toBe('tcp');
    expect(info.host).toBe('127.0.0.1');
    expect(info.port).toBe(55555);
  });
});

describe('isDaemonRunning', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-transport-async-'));
    process.env.XDG_RUNTIME_DIR = tmpRoot;
    cleanupIpcArtifacts();
    removePidFile();
  });

  afterEach(() => {
    cleanupIpcArtifacts();
    removePidFile();
    delete process.env.XDG_RUNTIME_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns true when pid file matches live process', async () => {
    writePidFile();
    await expectDaemonRunning(true);
  });

  it('on win32 returns true when address file exists without live pid', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    writeAddressFile('127.0.0.1', 12345);
    await expectDaemonRunning(true);
    Object.defineProperty(process, 'platform', { value: original });
  });

  it('on unix probes socket connectivity', async (context) => {
    if (process.platform === 'win32') { context.skip(); return; }
    Object.defineProperty(process, 'platform', { value: 'linux' });
    ensureSocketDir();
    const socketPath = getDefaultSocketPath();
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await expectDaemonRunning(true);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    } finally {
      server.close();
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    }
  });
});
