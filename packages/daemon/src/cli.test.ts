/**
 * CLI tests
 *
 * - list-engines / list-models data layer (no subprocess)
 * - CLI subprocess tests via index.ts entrypoint (program.parse at load)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEngines, fetchModels } from './core/engines.js';
import { getPidPath } from './core/paths.js';
import { ensureRuntimeDir } from './daemon/transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, 'daemon/index.ts');

interface CliResult {
  code: number | null;
  output: string;
}

function cliEnv(runtimeDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    ABBENAY_DEBUG: '0',
    ...extra,
  };
}

function runCli(args: string[], runtimeDir: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let output = '';
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, ...args],
      {
        env: cliEnv(runtimeDir, extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, output }));
  });
}

describe('list-engines', () => {
  it('returns engines with ids that can be sorted alphabetically', () => {
    const ids = getEngines().map(e => e.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));

    expect(ids.length).toBeGreaterThan(0);
    expect(sorted).toEqual(expect.arrayContaining(ids));
    expect(sorted.length).toBe(ids.length);
  });

  it('every engine has required fields', () => {
    for (const e of getEngines()) {
      expect(e.id).toBeTruthy();
      expect(typeof e.requiresKey).toBe('boolean');
      expect(typeof e.supportsTools).toBe('boolean');
    }
  });

  it('includes known engines', () => {
    const ids = new Set(getEngines().map(e => e.id));
    for (const expected of ['openai', 'anthropic', 'ollama', 'mock']) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});

describe('list-models --discover mock', () => {
  it('returns mock models without network access', async () => {
    const models = await fetchModels('mock');
    expect(models.length).toBeGreaterThan(0);

    const ids = models.map(m => m.id);
    expect(ids).toContain('echo');
    expect(ids).toContain('fixed');
  });

  it('returned models have valid structure', async () => {
    const models = await fetchModels('mock');
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.engine).toBe('mock');
      expect(typeof m.contextWindow).toBe('number');
    }
  });

  it('returns empty array for unknown engine', async () => {
    const models = await fetchModels('nonexistent-engine-xyz');
    expect(models).toEqual([]);
  });
});

describe('CLI subprocess', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abbenay-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
  });

  it('validatePort rejects invalid values via web -p', async () => {
    const { code, output } = await runCli(['web', '-p', 'abc'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/Invalid port/);
  });

  it('validatePort accepts numeric ports (bind may fail for other reasons)', async () => {
    const { output } = await runCli([
      'daemon',
      '--grpc-port', '50051',
      '--grpc-host', '0.0.0.0',
    ], tmpRoot);
    expect(output).not.toMatch(/Invalid port/);
  });

  it('grpc bind policy rejects 0.0.0.0 without TLS or --insecure', async () => {
    const { code, output } = await runCli([
      'daemon',
      '--grpc-port', '50051',
      '--grpc-host', '0.0.0.0',
    ], tmpRoot);
    expect(code).not.toBe(0);
    expect(output).toMatch(/Refusing to bind gRPC|Failed to start daemon/);
  });

  it('status exits 1 when daemon not running', async () => {
    const { code, output } = await runCli(['status'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/not running/);
  });

  it('status prints running daemon info when PID file matches live process', async () => {
    process.env.XDG_RUNTIME_DIR = tmpRoot;
    ensureRuntimeDir();
    fs.writeFileSync(getPidPath(), String(process.pid), { mode: 0o600 });
    delete process.env.XDG_RUNTIME_DIR;

    const { code, output } = await runCli(['status'], tmpRoot);
    expect(code).toBe(0);
    expect(output).toMatch(/Abbenay daemon is running/);
    expect(output).toMatch(new RegExp(`PID:\\s+${process.pid}`));
  });

  it('status uses Address label on win32', async () => {
    if (process.platform !== 'win32') return;

    process.env.XDG_RUNTIME_DIR = tmpRoot;
    ensureRuntimeDir();
    fs.writeFileSync(getPidPath(), String(process.pid), { mode: 0o600 });
    fs.writeFileSync(path.join(tmpRoot, 'daemon.addr'), '127.0.0.1:43210\n', { mode: 0o600 });
    delete process.env.XDG_RUNTIME_DIR;

    const { code, output } = await runCli(['status'], tmpRoot);
    expect(code).toBe(0);
    expect(output).toMatch(/Address:\s+127\.0\.0\.1:43210/);
  });

  it('stop exits 1 when no daemon PID file exists', async () => {
    const { code, output } = await runCli(['stop'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/Failed to stop daemon|No daemon PID/);
  });

  it('list-engines prints table headers', async () => {
    const { code, output } = await runCli(['list-engines'], tmpRoot);
    expect(code).toBe(0);
    expect(output).toMatch(/ENGINE/);
  });

  it('list-engines --json outputs JSON array', async () => {
    const { code, output } = await runCli(['list-engines', '--json'], tmpRoot);
    expect(code).toBe(0);
    const jsonLine = output.trim().split('\n').find((line) => line.startsWith('['));
    expect(jsonLine).toBeTruthy();
    expect(JSON.parse(jsonLine!)).toBeInstanceOf(Array);
  });

  it('list-models prints configured models hint', async () => {
    const { code, output } = await runCli(['list-models'], tmpRoot);
    expect(code).toBe(0);
    expect(output).toMatch(/Use with:|No models configured/);
  });

  it('list-models --json outputs JSON', async () => {
    const { code, output } = await runCli(['list-models', '--json'], tmpRoot);
    expect(code).toBe(0);
    expect(() => JSON.parse(output.trim())).not.toThrow();
  });

  it('list-models --discover unknown engine exits 1', async () => {
    const { code, output } = await runCli(['list-models', '--discover', 'not-real'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/Unknown engine|not-real/);
  });

  it('list-models --discover requires api key when needed', async () => {
    const { code, output } = await runCli(['list-models', '--discover', 'openai'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/API key|OPENAI_API_KEY/i);
  });

  it('list-models --discover fetches mock models', async () => {
    const { code, output } = await runCli(['list-models', '--discover', 'mock', '--json'], tmpRoot);
    expect(code).toBe(0);
    const models = JSON.parse(output.trim()) as Array<{ id: string }>;
    expect(models.some((m) => m.id === 'echo')).toBe(true);
  });

  it('sessions list prints empty message', async () => {
    const { code, output } = await runCli(['sessions', 'list'], tmpRoot);
    expect(code).toBe(0);
    expect(output).toMatch(/No sessions found\.|session\(s\) total/);
  });

  it('sessions list --json outputs result', async () => {
    const { code, output } = await runCli(['sessions', 'list', '--json'], tmpRoot);
    expect(code).toBe(0);
    const parsed = JSON.parse(output.trim()) as { sessions: unknown[] };
    expect(Array.isArray(parsed.sessions)).toBe(true);
  });

  it('sessions show missing session exits 1', async () => {
    const { code, output } = await runCli(['sessions', 'show', 'missing-id'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/Session not found/);
  });

  it('sessions delete missing session exits 1', async () => {
    const { code, output } = await runCli(['sessions', 'delete', 'missing-id'], tmpRoot);
    expect(code).toBe(1);
    expect(output).toMatch(/Session not found/);
  });
});
