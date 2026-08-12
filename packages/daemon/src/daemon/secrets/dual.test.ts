/**
 * Unit tests for DualSecretStore (memory + keychain, move-on-write).
 */

import { describe, it, expect } from 'vitest';
import { MemorySecretStore, type SecretStore } from '../../core/secrets.js';
import {
  DualSecretStore,
  parseSecretStoreChoice,
  secretBackendToProto,
} from './dual.js';

function createDual() {
  const memory = new MemorySecretStore();
  const keychain = new MemorySecretStore(); // stand-in for keychain in unit tests
  const dual = new DualSecretStore(memory, keychain);
  return { dual, memory, keychain };
}

describe('DualSecretStore', () => {
  it('set defaults to keychain and clears memory for the same key', async () => {
    const { dual, memory, keychain } = createDual();
    await memory.set('K', 'from-memory');
    await dual.set('K', 'from-keychain');

    expect(await dual.get('K')).toBe('from-keychain');
    expect(await keychain.has('K')).toBe(true);
    expect(await memory.has('K')).toBe(false);
    expect(await dual.locate('K')).toBe('keychain');
  });

  it('setIn memory moves the key out of keychain', async () => {
    const { dual, memory, keychain } = createDual();
    await dual.setIn('keychain', 'K', 'persistent');
    await dual.setIn('memory', 'K', 'ephemeral');

    expect(await dual.get('K')).toBe('ephemeral');
    expect(await memory.get('K')).toBe('ephemeral');
    expect(await keychain.has('K')).toBe(false);
    expect(await dual.locate('K')).toBe('memory');
  });

  it('get prefers memory when both somehow hold a value', async () => {
    const { dual, memory, keychain } = createDual();
    // Bypass setIn to simulate inconsistent state
    await memory.set('K', 'mem');
    await keychain.set('K', 'kc');
    expect(await dual.get('K')).toBe('mem');
  });

  it('delete clears both backends', async () => {
    const { dual, memory, keychain } = createDual();
    await memory.set('A', '1');
    await keychain.set('B', '2');
    expect(await dual.delete('A')).toBe(true);
    expect(await dual.delete('B')).toBe(true);
    expect(await dual.delete('missing')).toBe(false);
    expect(await memory.has('A')).toBe(false);
    expect(await keychain.has('B')).toBe(false);
  });

  it('has and locate reflect the active backend', async () => {
    const { dual } = createDual();
    expect(await dual.has('K')).toBe(false);
    expect(await dual.locate('K')).toBeNull();

    await dual.setIn('memory', 'K', 'v');
    expect(await dual.has('K')).toBe(true);
    expect(await dual.locate('K')).toBe('memory');

    await dual.setIn('keychain', 'K', 'v2');
    expect(await dual.locate('K')).toBe('keychain');
  });

  it('fails closed when the other backend still has the key after delete', async () => {
    const sticky = new Map<string, string>([['K', 'old-persistent']]);
    const memory = new MemorySecretStore();
    const stickyKeychain: SecretStore = {
      async get(key) {
        return sticky.get(key) ?? null;
      },
      async set(key, value) {
        sticky.set(key, value);
      },
      async delete() {
        return false; // soft-fail like KeychainSecretStore on error
      },
      async has(key) {
        return sticky.has(key);
      },
    };
    const dual = new DualSecretStore(memory, stickyKeychain);

    await expect(dual.setIn('memory', 'K', 'ephemeral')).rejects.toThrow(/Failed to clear/);
    expect(await memory.has('K')).toBe(false);
    expect(await stickyKeychain.has('K')).toBe(true);
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

  it('rejects ENV writes', () => {
    const result = parseSecretStoreChoice('SECRET_STORE_ENV');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ENV/i);
    }
  });

  it('rejects unknown stores', () => {
    const result = parseSecretStoreChoice('vault');
    expect(result.ok).toBe(false);
  });
});

describe('secretBackendToProto', () => {
  it('maps backends to proto enum numbers', () => {
    expect(secretBackendToProto('keychain')).toBe(1);
    expect(secretBackendToProto('memory')).toBe(3);
    expect(secretBackendToProto(null)).toBe(0);
  });
});
