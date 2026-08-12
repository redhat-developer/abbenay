/**
 * Dual secret store: process-lifetime memory + OS keychain backends.
 *
 * Same key name lives in exactly one backend (move-on-write). Default
 * {@link SecretStore.set} targets keychain for backward compatibility.
 */

import type { SecretStore } from '../../core/secrets.js';

/** Writable DualSecretStore backends. */
export type SecretBackend = 'memory' | 'keychain';

/** Full secret_store vocabulary including env references. */
export type SecretStoreKind = SecretBackend | 'env';

/**
 * Composite store used by the daemon.
 *
 * - `set` → keychain (existing configure / addProvider callers)
 * - `setIn('memory' | 'keychain', …)` → write target + delete from the other
 * - `get` / `has` → memory first, then keychain (at most one hit)
 * - `delete` → both backends
 * - `locate` → which backend holds the key (for List / SecretInfo)
 */
export class DualSecretStore implements SecretStore {
  constructor(
    private readonly memory: SecretStore,
    private readonly keychain: SecretStore,
  ) {}

  /** Expose backends for tests that assert exclusivity. */
  get memoryStore(): SecretStore {
    return this.memory;
  }

  get keychainStore(): SecretStore {
    return this.keychain;
  }

  async get(key: string): Promise<string | null> {
    const fromMemory = await this.memory.get(key);
    if (fromMemory !== null) return fromMemory;
    return this.keychain.get(key);
  }

  /** Default write path: keychain (persistent). */
  async set(key: string, value: string): Promise<void> {
    await this.setIn('keychain', key, value);
  }

  /**
   * Write to one backend and remove the same key from the other
   * (mutual exclusivity — no overlay / sync).
   *
   * Fails closed if the other backend still holds the key after delete
   * (e.g. keychain soft-fail), so callers cannot believe a memory write
   * is ephemeral while an OS keychain residue remains.
   */
  async setIn(backend: SecretBackend, key: string, value: string): Promise<void> {
    const primary = backend === 'memory' ? this.memory : this.keychain;
    const other = backend === 'memory' ? this.keychain : this.memory;
    const otherName = backend === 'memory' ? 'keychain' : 'memory';

    await primary.set(key, value);

    try {
      await other.delete(key);
    } catch (error: unknown) {
      // Roll back primary so we do not leave a dual-resident key.
      try {
        await primary.delete(key);
      } catch {
        /* ignore rollback errors */
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to clear secret '${key}' from ${otherName} after write to ${backend}: ${msg}`,
      );
    }

    if (await other.has(key)) {
      try {
        await primary.delete(key);
      } catch {
        /* ignore rollback errors */
      }
      throw new Error(
        `Failed to clear secret '${key}' from ${otherName} after write to ${backend}`,
      );
    }
  }

  async delete(key: string): Promise<boolean> {
    const fromMemory = await this.memory.delete(key);
    const fromKeychain = await this.keychain.delete(key);
    return fromMemory || fromKeychain;
  }

  async has(key: string): Promise<boolean> {
    if (await this.memory.has(key)) return true;
    return this.keychain.has(key);
  }

  /** Which backend currently holds the key, if any. */
  async locate(key: string): Promise<SecretBackend | null> {
    if (await this.memory.has(key)) return 'memory';
    if (await this.keychain.has(key)) return 'keychain';
    return null;
  }
}

export function isDualSecretStore(store: SecretStore): store is DualSecretStore {
  return store instanceof DualSecretStore;
}

/**
 * Parse SetSecret / ConfigureProvider `store` / `secret_store` field.
 * Unspecified / omitted / keychain → keychain (default for writes).
 * ENV rejected for writes unless `allowEnv` (configure/reference only).
 */
export function parseSecretStoreChoice(
  store: unknown,
  opts?: { allowEnv?: boolean },
): { ok: true; backend: SecretStoreKind } | { ok: false; error: string } {
  if (
    store === undefined ||
    store === null ||
    store === '' ||
    store === 0 ||
    store === '0' ||
    store === 'SECRET_STORE_UNSPECIFIED' ||
    store === 'keychain' ||
    store === 'SECRET_STORE_KEYCHAIN' ||
    store === 1 ||
    store === '1'
  ) {
    return { ok: true, backend: 'keychain' };
  }
  if (store === 'memory' || store === 'SECRET_STORE_MEMORY' || store === 3 || store === '3') {
    return { ok: true, backend: 'memory' };
  }
  if (store === 'env' || store === 'SECRET_STORE_ENV' || store === 2 || store === '2') {
    if (opts?.allowEnv) {
      return { ok: true, backend: 'env' };
    }
    return {
      ok: false,
      error:
        'SECRET_STORE_ENV is not writable via SetSecret; configure the provider with ' +
        'secret_name + secret_store=env (or api_key_env_var_name)',
    };
  }
  return { ok: false, error: `Unsupported secret store: ${String(store)}` };
}

/** Proto SecretStore enum numeric values for ListSecrets / SecretInfo. */
export function secretBackendToProto(backend: SecretBackend | null): number {
  if (backend === 'memory') return 3; // SECRET_STORE_MEMORY
  if (backend === 'keychain') return 1; // SECRET_STORE_KEYCHAIN
  return 0; // SECRET_STORE_UNSPECIFIED
}
