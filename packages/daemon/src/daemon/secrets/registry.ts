/**
 * Registry of discrete secret backends (memory + keychain today).
 *
 * Each backend is independent — the same key name may exist in more than one.
 * Resolution is always (secret_store, secret_name). The {@link SecretStore}
 * interface methods map to the default backend (keychain) for backward
 * compatibility; prefer {@link SecretStoreRegistry.getFrom} / {@link setIn} /
 * {@link deleteFrom} / {@link hasIn} for explicit store selection.
 *
 * `env` is not registered here — it is a configure/resolve credential source
 * (`process.env`), not a daemon-owned writable store.
 */

import type { SecretStore } from '../../core/secrets.js';

/** Built-in writable registry backends. */
export type SecretBackend = 'memory' | 'keychain';

/** Full secret_store vocabulary including env references. */
export type SecretStoreKind = SecretBackend | 'env';

/** Default writable backend when store is omitted (backward compatible). */
export const DEFAULT_SECRET_BACKEND: SecretBackend = 'keychain';

/**
 * Maps store id → {@link SecretStore} implementation.
 *
 * - `set` / `get` / `has` / `delete` → {@link DEFAULT_SECRET_BACKEND} (keychain)
 * - `setIn` / `getFrom` / `hasIn` / `deleteFrom` → explicit backend
 * - `locateAll` → every backend that currently holds a key
 */
export class SecretStoreRegistry implements SecretStore {
  constructor(
    private readonly memory: SecretStore,
    private readonly keychain: SecretStore,
  ) {}

  /** Expose backends for tests and future registry iteration. */
  get memoryStore(): SecretStore {
    return this.memory;
  }

  get keychainStore(): SecretStore {
    return this.keychain;
  }

  /** Built-in writable backends (order stable for ListSecrets). */
  backends(): readonly SecretBackend[] {
    return ['memory', 'keychain'] as const;
  }

  private storeFor(backend: SecretBackend): SecretStore {
    return backend === 'memory' ? this.memory : this.keychain;
  }

  private requireBackend(backend: string): SecretBackend {
    if (backend === 'memory' || backend === 'keychain') return backend;
    throw new Error(`Unknown secret store: ${backend}`);
  }

  /** SecretStore interface → default keychain namespace. */
  async get(key: string): Promise<string | null> {
    return this.getFrom(DEFAULT_SECRET_BACKEND, key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.setIn(DEFAULT_SECRET_BACKEND, key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.deleteFrom(DEFAULT_SECRET_BACKEND, key);
  }

  async has(key: string): Promise<boolean> {
    return this.hasIn(DEFAULT_SECRET_BACKEND, key);
  }

  async getFrom(backend: string, key: string): Promise<string | null> {
    return this.storeFor(this.requireBackend(backend)).get(key);
  }

  /** Write to one backend only — does not clear other namespaces. */
  async setIn(backend: string, key: string, value: string): Promise<void> {
    await this.storeFor(this.requireBackend(backend)).set(key, value);
  }

  async deleteFrom(backend: string, key: string): Promise<boolean> {
    return this.storeFor(this.requireBackend(backend)).delete(key);
  }

  async hasIn(backend: string, key: string): Promise<boolean> {
    return this.storeFor(this.requireBackend(backend)).has(key);
  }

  /** Backends that currently hold `key` (may be empty, one, or many). */
  async locateAll(key: string): Promise<SecretBackend[]> {
    const found: SecretBackend[] = [];
    for (const backend of this.backends()) {
      if (await this.hasIn(backend, key)) found.push(backend);
    }
    return found;
  }

  /**
   * @deprecated Prefer {@link locateAll}. Returns the first backend that holds
   * the key (memory before keychain), or null.
   */
  async locate(key: string): Promise<SecretBackend | null> {
    const all = await this.locateAll(key);
    return all[0] ?? null;
  }
}

export function isSecretStoreRegistry(store: SecretStore): store is SecretStoreRegistry {
  return store instanceof SecretStoreRegistry;
}

/**
 * Parse SetSecret / ConfigureProvider `store` / `secret_store` field.
 * Unspecified / omitted / keychain → keychain (default for writes).
 * ENV rejected for writes unless `allowEnv` (configure/reference only).
 */
export function parseSecretStoreChoice(
  store: unknown,
  opts: { allowEnv: true },
): { ok: true; backend: SecretStoreKind } | { ok: false; error: string };
export function parseSecretStoreChoice(
  store: unknown,
  opts?: { allowEnv?: false | undefined },
): { ok: true; backend: SecretBackend } | { ok: false; error: string };
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
