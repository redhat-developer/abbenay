/**
 * Registry of discrete secret backends (memory + keychain + file).
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
import { MemorySecretStore } from '../../core/secrets.js';

/** Built-in writable registry backends. */
export type SecretBackend = 'memory' | 'keychain' | 'file';

/** Full secret_store vocabulary including env references. */
export type SecretStoreKind = SecretBackend | 'env';

/** Default writable backend when store is omitted (backward compatible). */
export const DEFAULT_SECRET_BACKEND: SecretBackend = 'keychain';

const WRITABLE_BACKENDS: readonly SecretBackend[] = ['memory', 'keychain', 'file'] as const;

/** True when ``s`` is a daemon-owned writable store id (not env). */
export function isWritableSecretBackend(s: string): s is SecretBackend {
  return s === 'memory' || s === 'keychain' || s === 'file';
}

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
    /** Defaults to in-memory stand-in so unit tests need not touch disk. */
    private readonly file: SecretStore = new MemorySecretStore(),
  ) {}

  /** Expose backends for tests and future registry iteration. */
  get memoryStore(): SecretStore {
    return this.memory;
  }

  get keychainStore(): SecretStore {
    return this.keychain;
  }

  get fileStore(): SecretStore {
    return this.file;
  }

  /** Built-in writable backends (order stable for ListSecrets). */
  backends(): readonly SecretBackend[] {
    return WRITABLE_BACKENDS;
  }

  private storeFor(backend: SecretBackend): SecretStore {
    if (backend === 'memory') return this.memory;
    if (backend === 'file') return this.file;
    return this.keychain;
  }

  private requireBackend(backend: string): SecretBackend {
    if (isWritableSecretBackend(backend)) return backend;
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
   * the key (memory before keychain before file), or null.
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
 * Memory is only meaningful with {@link SecretStoreRegistry}. Reject it when the
 * daemon is running a plain SecretStore so clients cannot request memory while
 * the write silently lands in keychain (or another non-ephemeral backend).
 */
export function requireNamespacedMemory(
  registry: SecretStoreRegistry | null,
  backend: string,
): { ok: true } | { ok: false; error: string } {
  if ((backend === 'memory' || backend === 'file') && !registry) {
    return {
      ok: false,
      error:
        `secret_store=${backend} requires a namespaced secret store ` +
        '(memory + keychain + file); this daemon is not running with SecretStoreRegistry',
    };
  }
  return { ok: true };
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
  if (store === 'file' || store === 'SECRET_STORE_FILE' || store === 4 || store === '4') {
    return { ok: true, backend: 'file' };
  }
  if (store === 'env' || store === 'SECRET_STORE_ENV' || store === 2 || store === '2') {
    if (opts?.allowEnv) {
      return { ok: true, backend: 'env' };
    }
    return {
      ok: false,
      error:
        'SECRET_STORE_ENV is not writable via the secrets API; configure the provider with ' +
        'secret_name + secret_store=env (or api_key_env_var_name)',
    };
  }
  return { ok: false, error: `Unsupported secret store: ${String(store)}` };
}

/** Proto SecretStore enum numeric values for ListSecrets / SecretInfo. */
export function secretBackendToProto(backend: SecretBackend | null): number {
  if (backend === 'keychain') return 1; // SECRET_STORE_KEYCHAIN
  if (backend === 'memory') return 3; // SECRET_STORE_MEMORY
  if (backend === 'file') return 4; // SECRET_STORE_FILE
  return 0; // SECRET_STORE_UNSPECIFIED
}
