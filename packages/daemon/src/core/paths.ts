/**
 * Platform-aware path utilities for Abbenay
 *
 * All daemon, extension, and CLI code should use these helpers to ensure
 * consistent file placement across Linux, macOS, and Windows.
 *
 * Conventions:
 *   Runtime dir  (ephemeral: PID, socket, lock)
 *     Linux:   $XDG_RUNTIME_DIR/abbenay  → /run/user/<uid>/abbenay
 *     macOS:   os.tmpdir()/abbenay        → /var/folders/.../abbenay
 *     Windows: named pipe (no dir needed for socket)
 *     Fallback: /tmp/abbenay
 *
 *   Config dir   (persistent user config)
 *     Linux:   $XDG_CONFIG_HOME/abbenay   → ~/.config/abbenay
 *     macOS:   ~/Library/Application Support/abbenay
 *     Windows: %APPDATA%/abbenay
 *
 *   Workspace config dir
 *     All:     <workspace>/.config/abbenay
 */

import * as os from 'node:os';
import * as path from 'node:path';

const APP_NAME = 'abbenay';

/** Default HTTP port for the web dashboard and API server. */
export const DEFAULT_WEB_PORT = 8787;

// ── Runtime directory ────────────────────────────────────────────────

/**
 * Get the platform runtime directory (for ephemeral files: PID, socket, lock).
 *
 * - Linux:  XDG_RUNTIME_DIR  → /run/user/<uid>
 * - macOS:  os.tmpdir()      → /var/folders/...
 * - Other:  /tmp
 */
export function getRuntimeDir(): string {
    // 1. Respect XDG_RUNTIME_DIR (standard on Linux)
    if (process.env.XDG_RUNTIME_DIR) {
        return path.join(process.env.XDG_RUNTIME_DIR, APP_NAME);
    }

    // 2. macOS — os.tmpdir() returns DARWIN_USER_TEMP_DIR automatically
    if (process.platform === 'darwin') {
        return path.join(os.tmpdir(), APP_NAME);
    }

    // 3. Linux without XDG_RUNTIME_DIR — try /run/user/<uid>
    if (process.platform !== 'win32') {
        try {
            const uid = os.userInfo().uid;
            return path.join(`/run/user/${uid}`, APP_NAME);
        } catch {
            // os.userInfo() can fail in some sandboxes
        }
    }

    // 4. Fallback
    return path.join('/tmp', APP_NAME);
}

// ── Config directory ─────────────────────────────────────────────────

/**
 * Get the persistent user config directory.
 *
 * - macOS:   ~/Library/Application Support/abbenay
 * - Windows: %APPDATA%/abbenay
 * - Linux:   $XDG_CONFIG_HOME/abbenay → ~/.config/abbenay
 */
export function getConfigDir(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, APP_NAME);
    }

    // Linux / BSD — XDG Base Directory spec
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, APP_NAME);
}

// ── Data directory ──────────────────────────────────────────────────

/**
 * Get the persistent user data directory (sessions, exports, etc.).
 *
 * - macOS:   ~/Library/Application Support/abbenay
 * - Windows: %LOCALAPPDATA%/abbenay
 * - Linux:   $XDG_DATA_HOME/abbenay → ~/.local/share/abbenay
 */
export function getDataDir(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, APP_NAME);
    }

    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, APP_NAME);
}

/** Sessions directory:  <dataDir>/sessions */
export function getSessionsDir(): string {
    return path.join(getDataDir(), 'sessions');
}

// ── Workspace config directory ───────────────────────────────────────

/**
 * Get the workspace-level config directory.
 *
 *   <workspacePath>/.config/abbenay
 */
export function getWorkspaceConfigDir(workspacePath: string): string {
    return path.join(workspacePath, '.config', APP_NAME);
}

// ── Derived helpers ──────────────────────────────────────────────────

/** Socket path:  <runtimeDir>/daemon.sock  (or Windows named pipe) */
export function getSocketPath(): string {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\abbenay-daemon';
    }
    return path.join(getRuntimeDir(), 'daemon.sock');
}

/** PID file:  <runtimeDir>/abbenay.pid */
export function getPidPath(): string {
    return path.join(getRuntimeDir(), 'abbenay.pid');
}

/** User config file:  <configDir>/config.yaml */
export function getUserConfigPath(): string {
    return path.join(getConfigDir(), 'config.yaml');
}

/** Workspace config file:  <workspaceConfigDir>/config.yaml */
export function getWorkspaceConfigPath(workspacePath: string): string {
    return path.join(getWorkspaceConfigDir(workspacePath), 'config.yaml');
}

/** User policies file:  <configDir>/policies.yaml (user-level only, no workspace variant) */
export function getUserPoliciesPath(): string {
    return path.join(getConfigDir(), 'policies.yaml');
}
