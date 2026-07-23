/**
 * Transport layer for daemon communication
 *
 * Handles Unix socket (Linux/macOS) and loopback TCP + address file (Windows).
 * All paths come from ../core/paths.ts for platform-aware consistency.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  getRuntimeDir,
  getSocketPath,
  getPidPath,
  getAddressPath,
} from '../core/paths.js';

export interface Transport {
  type: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
}

export interface DaemonAddress {
  host: string;
  port: number;
}

/**
 * Get the default socket path for the current platform
 */
export function getDefaultSocketPath(): string {
  return getSocketPath();
}

/**
 * Get the PID file path
 */
export function getPidFilePath(): string {
  return getPidPath();
}

/**
 * Ensure the socket directory exists (Unix only).
 * On Windows, local IPC uses TCP + daemon.addr under the runtime dir.
 */
export function ensureSocketDir(): void {
  if (process.platform === 'win32') {
    ensureRuntimeDir();
    return;
  }

  const socketDir = path.dirname(getSocketPath());

  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Ensure the runtime directory exists (for PID, socket/address, lock)
 */
export function ensureRuntimeDir(): void {
  const runtimeDir = getRuntimeDir();

  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Clean up stale Unix socket file (no-op on Windows).
 */
export function cleanupSocket(): void {
  if (process.platform === 'win32') {
    return;
  }

  const socketPath = getSocketPath();

  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (_error) {
      // Ignore errors - socket might be in use
    }
  }
}

/**
 * Parse `host:port` from a daemon.addr file contents.
 */
export function parseAddressFileContent(content: string): DaemonAddress | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  // IPv6 would be [host]:port; we only write IPv4 loopback today.
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === trimmed.length - 1) {
    return null;
  }

  const host = trimmed.slice(0, lastColon).trim();
  const port = parseInt(trimmed.slice(lastColon + 1).trim(), 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }

  return { host, port };
}

/**
 * Write host:port to the address file (Windows loopback TCP IPC).
 */
export function writeAddressFile(host: string, port: number): void {
  ensureRuntimeDir();
  const addrPath = getAddressPath();
  fs.writeFileSync(addrPath, `${host}:${port}\n`, { mode: 0o600 });
}

/**
 * Read host:port from the address file.
 */
export function readAddressFile(): DaemonAddress | null {
  const addrPath = getAddressPath();
  if (!fs.existsSync(addrPath)) {
    return null;
  }
  try {
    return parseAddressFileContent(fs.readFileSync(addrPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Remove the address file.
 */
export function removeAddressFile(): void {
  const addrPath = getAddressPath();
  if (fs.existsSync(addrPath)) {
    try {
      fs.unlinkSync(addrPath);
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Clean up IPC endpoint artifacts (Unix socket and/or address file).
 */
export function cleanupIpcArtifacts(): void {
  cleanupSocket();
  removeAddressFile();
}

/**
 * Write PID file
 */
export function writePidFile(): void {
  ensureRuntimeDir();
  const pidPath = getPidPath();
  fs.writeFileSync(pidPath, process.pid.toString(), { mode: 0o600 });
}

/**
 * Read PID from file
 */
export function readPidFile(): number | null {
  const pidPath = getPidPath();

  if (!fs.existsSync(pidPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim();
    return parseInt(content, 10);
  } catch {
    return null;
  }
}

/**
 * Remove PID file
 */
export function removePidFile(): void {
  const pidPath = getPidPath();

  if (fs.existsSync(pidPath)) {
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether a TCP host:port accepts connections.
 */
export function probeTcpAddress(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Check if daemon is running by testing PID + IPC endpoint.
 * On Windows this probes TCP using daemon.addr; on Unix it checks the socket path.
 */
export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    return true;
  }

  if (process.platform === 'win32') {
    const addr = readAddressFile();
    if (!addr) {
      return false;
    }
    // Best-effort async probe cast (matches historical Unix helper shape)
    return probeTcpAddress(addr.host, addr.port) as unknown as boolean;
  }

  const socketPath = getSocketPath();

  // Check if socket exists and is connectable
  if (!fs.existsSync(socketPath)) {
    return false;
  }

  // Try to connect briefly
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  }) as unknown as boolean; // Sync check for simple cases
}

/**
 * Check daemon status synchronously (best effort)
 *
 * Only considers the daemon running if:
 * 1. PID file exists AND the process is alive, OR
 * 2. None of the above — if only a stale socket/address exists, we treat it as not running
 */
export function isDaemonRunningSync(): boolean {
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    return true;
  }

  // If PID file has a stale PID, clean up
  if (pid && !isProcessRunning(pid)) {
    removePidFile();
    cleanupIpcArtifacts();
  }

  return false;
}

/**
 * Kill daemon process
 */
export function killDaemon(): boolean {
  const pid = readPidFile();

  if (!pid) {
    return false;
  }

  try {
    // Send SIGTERM first
    process.kill(pid, 'SIGTERM');

    // Wait briefly then check if still running
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      if (!isProcessRunning(pid)) {
        break;
      }
      // Busy wait (not ideal, but simple)
    }

    // Force kill if still running
    if (isProcessRunning(pid)) {
      process.kill(pid, 'SIGKILL');
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get transport configuration for the current platform.
 */
export function getTransport(): Transport {
  if (process.platform === 'win32') {
    const addr = readAddressFile();
    return {
      type: 'tcp',
      host: addr?.host ?? '127.0.0.1',
      port: addr?.port,
    };
  }

  return {
    type: 'unix',
    socketPath: getSocketPath(),
  };
}
