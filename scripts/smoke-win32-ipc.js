#!/usr/bin/env node
/**
 * Windows IPC smoke test: start the SEA daemon, read daemon.addr, HealthCheck over TCP.
 *
 * Usage (after ci:build on Windows):
 *   node scripts/smoke-win32-ipc.js
 *
 * Exit 0 on success.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEA_DIR = path.join(ROOT, 'dist', 'win32-x64');
const SEA_NAME = 'abbenay-daemon-win32-x64.exe';
const RUNTIME_DIR = path.join(os.tmpdir(), 'abbenay');
const ADDR_FILE = path.join(RUNTIME_DIR, 'daemon.addr');
const PID_FILE = path.join(RUNTIME_DIR, 'abbenay.pid');
const PROTO = path.join(ROOT, 'proto', 'abbenay', 'v1', 'service.proto');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseAddress(content) {
  const trimmed = content.trim();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }
  const host = trimmed.slice(0, lastColon).trim();
  const port = parseInt(trimmed.slice(lastColon + 1).trim(), 10);
  if (!host || !Number.isFinite(port)) {
    return null;
  }
  return { host, port };
}

async function waitForAddress(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(ADDR_FILE)) {
      const addr = parseAddress(fs.readFileSync(ADDR_FILE, 'utf8'));
      if (addr) {
        return addr;
      }
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${ADDR_FILE}`);
}

function healthCheck(host, port) {
  const packageDefinition = protoLoader.loadSync(PROTO, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.join(ROOT, 'proto')],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition);
  const Abbenay = proto.abbenay.v1.Abbenay;
  const client = new Abbenay(
    `${host}:${port}`,
    grpc.credentials.createInsecure(),
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.close();
      reject(new Error('HealthCheck timed out'));
    }, 10000);

    client.HealthCheck({}, (err, response) => {
      clearTimeout(timer);
      client.close();
      if (err) {
        reject(err);
        return;
      }
      resolve(response);
    });
  });
}

function stopDaemon(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 3000);
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('smoke-win32-ipc: skipping (not win32)');
    return;
  }

  const seaPath = path.join(SEA_DIR, SEA_NAME);
  if (!fs.existsSync(seaPath)) {
    throw new Error(`SEA binary not found: ${seaPath}`);
  }

  // Clean stale IPC files from prior runs
  for (const f of [ADDR_FILE, PID_FILE]) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    } catch {
      // ignore
    }
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log(`Starting ${seaPath} daemon...`);
  const child = spawn(seaPath, ['daemon'], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let logs = '';
  child.stdout?.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr?.on('data', (d) => {
    logs += d.toString();
  });

  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`Daemon exited early code=${code} signal=${signal}`);
      console.error(logs);
    }
  });

  try {
    const addr = await waitForAddress();
    console.log(`daemon.addr -> ${addr.host}:${addr.port}`);

    const response = await healthCheck(addr.host, addr.port);
    if (!response?.healthy) {
      throw new Error(`HealthCheck failed: ${JSON.stringify(response)}`);
    }
    console.log(`HealthCheck OK (version=${response.version ?? 'unknown'})`);
  } finally {
    await stopDaemon(child);
    for (const f of [ADDR_FILE, PID_FILE]) {
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      } catch {
        // ignore
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
