/**
 * E2E (subprocess): gRPC TCP bind security policy (C2 + DR-036 consumers).
 *
 * - 127.0.0.1 plaintext → starts (local DX; empty consumers OK)
 * - 0.0.0.0 without TLS/--insecure → refused
 * - 0.0.0.0 with --grpc-tls but no consumers → refused (DR-036)
 * - 0.0.0.0 with --grpc-tls + --allow-open-auth → starts
 * - 0.0.0.0 with --insecure → starts (open auth implied)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.resolve(__dirname, '../../src/daemon/index.ts');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

interface SpawnResult {
  proc: ChildProcess;
  runtimeDir: string;
  output: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  waitExit: (timeoutMs?: number) => Promise<{ code: number | null; output: string }>;
  kill: () => Promise<void>;
}

const children: SpawnResult[] = [];

afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    await child.kill();
    fs.rmSync(child.runtimeDir, { recursive: true, force: true });
  }
});

function spawnDaemon(args: string[]): SpawnResult {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-e2e-'));
  let buf = '';
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', DAEMON_ENTRY, 'daemon', ...args],
    {
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        // Avoid inheriting a live daemon's socket from the developer machine
        ABBENAY_DEBUG: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  proc.stdout?.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
  proc.stderr?.on('data', (chunk: Buffer) => { buf += chunk.toString(); });

  const result: SpawnResult = {
    proc,
    runtimeDir,
    output: () => buf,
    waitFor: (pattern, timeoutMs = 15000) => new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (pattern.test(buf)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timeout waiting for ${pattern}. Output:\n${buf}`));
        } else if (proc.exitCode !== null && !pattern.test(buf)) {
          clearInterval(timer);
          reject(new Error(`Process exited ${proc.exitCode} before match. Output:\n${buf}`));
        }
      }, 50);
    }),
    waitExit: (timeoutMs = 15000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for exit. Output:\n${buf}`));
      }, timeoutMs);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output: buf });
      });
    }),
    kill: async () => {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 3000);
        proc.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };

  children.push(result);
  return result;
}

describe('E2E: gRPC TCP bind security (C2)', () => {
  it('starts TCP gRPC on 127.0.0.1 without TLS (local DX)', async () => {
    const port = await freePort();
    const child = spawnDaemon(['--grpc-port', String(port), '--grpc-host', '127.0.0.1']);
    await child.waitFor(/gRPC listening on 127\.0\.0\.1:\d+ \(plaintext\)/);
    expect(child.output()).toMatch(/listening on/);
  });

  it('refuses 0.0.0.0 without TLS and without --insecure', async () => {
    const port = await freePort();
    const child = spawnDaemon(['--grpc-port', String(port), '--grpc-host', '0.0.0.0']);
    const { code, output } = await child.waitExit();
    expect(code).not.toBe(0);
    expect(output).toMatch(/Refusing to bind gRPC|Failed to start daemon/);
    expect(output).toMatch(/--insecure|--grpc-tls/);
  });

  it('refuses 0.0.0.0 with --grpc-tls when no consumers configured', async () => {
    const port = await freePort();
    const child = spawnDaemon([
      '--grpc-port', String(port),
      '--grpc-host', '0.0.0.0',
      '--grpc-tls',
    ]);
    const { code, output } = await child.waitExit();
    expect(code).not.toBe(0);
    expect(output).toMatch(/without configured consumers|Failed to start daemon/);
    expect(output).toMatch(/--allow-open-auth|--insecure/);
  });

  it('starts on 0.0.0.0 with --grpc-tls and --allow-open-auth', async () => {
    const port = await freePort();
    const child = spawnDaemon([
      '--grpc-port', String(port),
      '--grpc-host', '0.0.0.0',
      '--grpc-tls',
      '--allow-open-auth',
    ]);
    await child.waitFor(/gRPC listening on 0\.0\.0\.0:\d+ \(TLS\)/);
    expect(child.output()).toMatch(/auto-generated self-signed cert/);
    expect(child.output()).toMatch(/open consumer auth/);
    const caPath = path.join(child.runtimeDir, 'abbenay', 'tls', 'ca.crt');
    expect(fs.existsSync(caPath)).toBe(true);
  });

  it('starts on 0.0.0.0 with --insecure (plaintext + open auth opt-in)', async () => {
    const port = await freePort();
    const child = spawnDaemon([
      '--grpc-port', String(port),
      '--grpc-host', '0.0.0.0',
      '--insecure',
    ]);
    await child.waitFor(/gRPC listening on 0\.0\.0\.0:\d+ \(plaintext\)/);
    expect(child.output()).toMatch(/--insecure \(plaintext\)|open consumer auth/);
  });

  it('starts on 0.0.0.0 with --grpc-tls when consumers are configured', async () => {
    const port = await freePort();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-e2e-home-'));
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-e2e-rt-'));

    // Platform config paths (see core/paths.ts)
    const configDir = process.platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Application Support', 'abbenay')
      : path.join(homeDir, '.config', 'abbenay');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      [
        'consumers:',
        '  e2e:',
        '    token_env: E2E_CONSUMER_TOKEN',
        '    capabilities:',
        '      chat: true',
        '      secrets: true',
        '',
      ].join('\n'),
    );

    let buf = '';
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', DAEMON_ENTRY, 'daemon',
        '--grpc-port', String(port),
        '--grpc-host', '0.0.0.0',
        '--grpc-tls'],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          XDG_RUNTIME_DIR: runtimeDir,
          XDG_CONFIG_HOME: path.join(homeDir, '.config'),
          E2E_CONSUMER_TOKEN: 'e2e-token',
          ABBENAY_DEBUG: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    proc.stdout?.on('data', (c: Buffer) => { buf += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { buf += c.toString(); });

    const child = {
      proc,
      runtimeDir: homeDir,
      output: () => buf,
      waitFor: (pattern: RegExp, timeoutMs = 15000) => new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (pattern.test(buf)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`Timeout waiting for ${pattern}. Output:\n${buf}`));
          } else if (proc.exitCode !== null && !pattern.test(buf)) {
            clearInterval(timer);
            reject(new Error(`Process exited ${proc.exitCode} before match. Output:\n${buf}`));
          }
        }, 50);
      }),
      kill: async () => {
        if (proc.exitCode !== null) return;
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            resolve();
          }, 3000);
          proc.on('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      },
    };
    children.push(child as SpawnResult);

    await child.waitFor(/gRPC listening on 0\.0\.0\.0:\d+ \(TLS\)/);
    expect(child.output()).toMatch(/Consumer authentication is required/);
  });
});
