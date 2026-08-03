/**
 * Platform-aware runtime paths for the VS Code daemon client.
 * Mirrors packages/daemon/src/core/paths.ts for PID / IPC discovery.
 */

import * as os from 'os';
import * as path from 'path';

const APP_NAME = 'abbenay';

/**
 * Get the platform runtime directory (for ephemeral files: PID, socket/address).
 */
export function getRuntimeDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  tmpdir: string = os.tmpdir(),
): string {
  if (env.XDG_RUNTIME_DIR) {
    return path.join(env.XDG_RUNTIME_DIR, APP_NAME);
  }

  if (platform === 'darwin') {
    return path.join(tmpdir, APP_NAME);
  }

  if (platform === 'win32') {
    return path.join(tmpdir, APP_NAME);
  }

  try {
    const uid = os.userInfo().uid;
    return path.join(`/run/user/${uid}`, APP_NAME);
  } catch {
    // os.userInfo() can fail in some sandboxes
  }

  return path.join('/tmp', APP_NAME);
}

/** PID file under the runtime dir. */
export function getPidFilePath(runtimeDir: string = getRuntimeDir()): string {
  return path.join(runtimeDir, `${APP_NAME}.pid`);
}

/** Unix socket path (not used for IPC on Windows). */
export function getSocketFilePath(
  runtimeDir: string = getRuntimeDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return '\\\\.\\pipe\\abbenay-daemon';
  }
  return path.join(runtimeDir, 'daemon.sock');
}

/** Address file for Windows loopback TCP IPC. */
export function getAddressFilePath(runtimeDir: string = getRuntimeDir()): string {
  return path.join(runtimeDir, 'daemon.addr');
}

/**
 * Parse `host:port` from daemon.addr contents.
 */
export function parseDaemonAddress(content: string): { host: string; port: number } | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

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
 * Bundled SEA binary filename for the given platform/arch.
 */
export function getBundledSeaBinaryName(
  platform: NodeJS.Platform | string = process.platform,
  arch: string = process.arch,
): string {
  const normalized =
    platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const base = `abbenay-daemon-${normalized}-${arch}`;
  return normalized === 'win32' ? `${base}.exe` : base;
}

/**
 * Default gRPC channel address for Unix platforms.
 */
export function getUnixDaemonAddress(socketFile: string): string {
  return `unix://${socketFile}`;
}
