import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';

import {
  DEFAULT_WEB_PORT,
  getRuntimeDir,
  getConfigDir,
  getDataDir,
  getSessionsDir,
  getWorkspaceConfigDir,
  getSocketPath,
  getPidPath,
  getUserConfigPath,
  getWorkspaceConfigPath,
  getUserPoliciesPath,
} from './paths.js';

// ── DEFAULT_WEB_PORT ─────────────────────────────────────────────────────────

describe('DEFAULT_WEB_PORT', () => {
  it('should be 8787', () => {
    expect(DEFAULT_WEB_PORT).toBe(8787);
  });
});

// ── getRuntimeDir ────────────────────────────────────────────────────────────

describe('getRuntimeDir', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should use XDG_RUNTIME_DIR when set', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const result = getRuntimeDir();
    expect(result).toBe('/run/user/1000/abbenay');
  });

  it('should use tmpdir on darwin when XDG_RUNTIME_DIR is unset', () => {
    delete process.env.XDG_RUNTIME_DIR;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const result = getRuntimeDir();
    expect(result).toContain('abbenay');
    expect(path.basename(result)).toBe('abbenay');
  });

  it('should try /run/user/<uid> on linux without XDG_RUNTIME_DIR', () => {
    delete process.env.XDG_RUNTIME_DIR;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const result = getRuntimeDir();
    expect(result).toMatch(/\babbenay$/);
  });
});

// ── getConfigDir ─────────────────────────────────────────────────────────────

describe('getConfigDir', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should use XDG_CONFIG_HOME on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.XDG_CONFIG_HOME = '/custom/config';
    expect(getConfigDir()).toBe('/custom/config/abbenay');
  });

  it('should default to ~/.config on linux without XDG_CONFIG_HOME', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.XDG_CONFIG_HOME;
    const result = getConfigDir();
    expect(result).toMatch(/\.config\/abbenay$/);
  });
});

// ── getDataDir ───────────────────────────────────────────────────────────────

describe('getDataDir', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should use XDG_DATA_HOME on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.XDG_DATA_HOME = '/custom/data';
    expect(getDataDir()).toBe('/custom/data/abbenay');
  });

  it('should default to ~/.local/share on linux without XDG_DATA_HOME', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.XDG_DATA_HOME;
    const result = getDataDir();
    expect(result).toMatch(/\.local\/share\/abbenay$/);
  });
});

// ── derived helpers ──────────────────────────────────────────────────────────

describe('getSessionsDir', () => {
  it('should be <dataDir>/sessions', () => {
    const result = getSessionsDir();
    expect(path.basename(result)).toBe('sessions');
  });
});

describe('getWorkspaceConfigDir', () => {
  it('should return <workspace>/.config/abbenay', () => {
    expect(getWorkspaceConfigDir('/my/project')).toBe('/my/project/.config/abbenay');
  });
});

describe('getSocketPath', () => {
  it('should end with daemon.sock on non-windows', () => {
    if (process.platform !== 'win32') {
      expect(getSocketPath()).toMatch(/daemon\.sock$/);
    }
  });
});

describe('getPidPath', () => {
  it('should end with abbenay.pid', () => {
    expect(getPidPath()).toMatch(/abbenay\.pid$/);
  });
});

describe('getUserConfigPath', () => {
  it('should end with config.yaml', () => {
    expect(getUserConfigPath()).toMatch(/config\.yaml$/);
  });
});

describe('getWorkspaceConfigPath', () => {
  it('should return <workspace>/.config/abbenay/config.yaml', () => {
    expect(getWorkspaceConfigPath('/proj')).toBe('/proj/.config/abbenay/config.yaml');
  });
});

describe('getUserPoliciesPath', () => {
  it('should end with policies.yaml', () => {
    expect(getUserPoliciesPath()).toMatch(/policies\.yaml$/);
  });
});
