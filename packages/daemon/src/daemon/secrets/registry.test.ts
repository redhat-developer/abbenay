/**
 * Unit tests for SecretStoreRegistry (discrete namespaced backends).
 */

import { describe, it, expect } from 'vitest';
import { MemorySecretStore } from '../../core/secrets.js';
import {
  SecretStoreRegistry,
  parseSecretStoreChoice,
  requireNamespacedMemory,
  secretBackendToProto,
} from './registry.js';

function createRegistry() {
  const memory = new MemorySecretStore();
  const keychain = new MemorySecretStore(); // stand-in for keychain in unit tests
  const file = new MemorySecretStore(); // stand-in for file store in unit tests
  const registry = new SecretStoreRegistry(memory, keychain, file);
  return { registry, memory, keychain, file };
}

describe('SecretStoreRegistry', () => {
  it('set defaults to keychain and leaves memory untouched', async () => {
    const { registry, memory, keychain } = createRegistry();
    await memory.set('K', 'from-memory');
    await registry.set('K', 'from-keychain');

    expect(await registry.get('K')).toBe('from-keychain');
    expect(await registry.getFrom('keychain', 'K')).toBe('from-keychain');
    expect(await registry.getFrom('memory', 'K')).toBe('from-memory');
    expect(await keychain.has('K')).toBe(true);
    expect(await memory.has('K')).toBe(true);
    expect(await registry.locateAll('K')).toEqual(['memory', 'keychain']);
  });

  it('setIn file is discrete from memory and keychain', async () => {
    const { registry, memory, keychain, file } = createRegistry();
    await registry.setIn('keychain', 'K', 'kc');
    await registry.setIn('memory', 'K', 'mem');
    await registry.setIn('file', 'K', 'disk');

    expect(await memory.get('K')).toBe('mem');
    expect(await keychain.get('K')).toBe('kc');
    expect(await file.get('K')).toBe('disk');
    expect(await registry.locateAll('K')).toEqual(['memory', 'keychain', 'file']);
  });

  it('secretBackendToProto maps file to 4', () => {
    expect(secretBackendToProto('file')).toBe(4);
    expect(secretBackendToProto('memory')).toBe(3);
    expect(secretBackendToProto('keychain')).toBe(1);
  });

  it('setIn memory does not clear keychain (discrete namespaces)', async () => {
    const { registry, memory, keychain } = createRegistry();
    await registry.setIn('keychain', 'K', 'persistent');
    await registry.setIn('memory', 'K', 'ephemeral');

    expect(await memory.get('K')).toBe('ephemeral');
    expect(await keychain.get('K')).toBe('persistent');
    expect(await registry.getFrom('memory', 'K')).toBe('ephemeral');
    expect(await registry.getFrom('keychain', 'K')).toBe('persistent');
  });

  it('SecretStore.get/has/delete map to keychain only', async () => {
    const { registry, memory } = createRegistry();
    await registry.setIn('memory', 'K', 'mem');
    expect(await registry.get('K')).toBeNull();
    expect(await registry.has('K')).toBe(false);

    await registry.set('K', 'kc');
    expect(await registry.get('K')).toBe('kc');
    expect(await memory.get('K')).toBe('mem');

    expect(await registry.delete('K')).toBe(true);
    expect(await registry.has('K')).toBe(false);
    expect(await memory.has('K')).toBe(true);
  });

  it('deleteFrom clears only the named backend', async () => {
    const { registry, memory, keychain } = createRegistry();
    await registry.setIn('memory', 'K', '1');
    await registry.setIn('keychain', 'K', '2');
    expect(await registry.deleteFrom('memory', 'K')).toBe(true);
    expect(await memory.has('K')).toBe(false);
    expect(await keychain.has('K')).toBe(true);
  });

  it('hasIn and locateAll reflect each backend independently', async () => {
    const { registry } = createRegistry();
    expect(await registry.locateAll('K')).toEqual([]);
    expect(await registry.locate('K')).toBeNull();

    await registry.setIn('memory', 'K', 'v');
    expect(await registry.hasIn('memory', 'K')).toBe(true);
    expect(await registry.hasIn('keychain', 'K')).toBe(false);
    expect(await registry.locateAll('K')).toEqual(['memory']);

    await registry.setIn('keychain', 'K', 'v2');
    expect(await registry.locateAll('K')).toEqual(['memory', 'keychain']);
  });

  it('rejects unknown backend ids', async () => {
    const { registry } = createRegistry();
    await expect(registry.getFrom('vault', 'K')).rejects.toThrow(/Unknown secret store/);
  });
});

describe('parseSecretStoreChoice', () => {
  it('defaults unspecified / keychain to keychain', () => {
    for (const store of [undefined, null, '', 0, 'SECRET_STORE_UNSPECIFIED', 'keychain', 1]) {
      expect(parseSecretStoreChoice(store)).toEqual({ ok: true, backend: 'keychain' });
    }
  });

  it('accepts memory', () => {
    for (const store of ['memory', 'SECRET_STORE_MEMORY', 3]) {
      expect(parseSecretStoreChoice(store)).toEqual({ ok: true, backend: 'memory' });
    }
  });

  it('accepts file', () => {
    for (const store of ['file', 'SECRET_STORE_FILE', 4, '4']) {
      expect(parseSecretStoreChoice(store)).toEqual({ ok: true, backend: 'file' });
    }
  });

  it('rejects ENV writes', () => {
    const result = parseSecretStoreChoice('SECRET_STORE_ENV');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ENV|not writable|secrets API/i);
    }
  });

  it('allows ENV when allowEnv is set (configure/reference)', () => {
    expect(parseSecretStoreChoice('env', { allowEnv: true })).toEqual({
      ok: true,
      backend: 'env',
    });
  });

  it('rejects unknown stores', () => {
    const result = parseSecretStoreChoice('vault');
    expect(result.ok).toBe(false);
  });
});

describe('requireNamespacedMemory', () => {
  it('allows memory and file when a registry is present', async () => {
    const { MemorySecretStore } = await import('../../core/secrets.js');
    const registry = new SecretStoreRegistry(
      new MemorySecretStore(),
      new MemorySecretStore(),
      new MemorySecretStore(),
    );
    expect(requireNamespacedMemory(registry, 'memory')).toEqual({ ok: true });
    expect(requireNamespacedMemory(registry, 'file')).toEqual({ ok: true });
    expect(requireNamespacedMemory(registry, 'keychain')).toEqual({ ok: true });
    expect(registry.fileStore).toBeDefined();
  });

  it('rejects memory when only a plain secret store is available', () => {
    const result = requireNamespacedMemory(null, 'memory');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/memory|SecretStoreRegistry/i);
    }
    expect(requireNamespacedMemory(null, 'keychain')).toEqual({ ok: true });
  });

  it('rejects file when only a plain secret store is available', () => {
    const result = requireNamespacedMemory(null, 'file');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/file|SecretStoreRegistry/i);
    }
  });
});

describe('secretBackendToProto', () => {
  it('maps backends to proto enum numbers', () => {
    expect(secretBackendToProto('keychain')).toBe(1);
    expect(secretBackendToProto('memory')).toBe(3);
    expect(secretBackendToProto('file')).toBe(4);
    expect(secretBackendToProto(null)).toBe(0);
  });
});
