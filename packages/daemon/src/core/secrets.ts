/**
 * Secret store interface and in-memory implementation.
 *
 * Core consumers inject their own SecretStore implementation.
 * The daemon uses KeychainSecretStore (keytar); tests use MemorySecretStore.
 */

// ── Interface ───────────────────────────────────────────────────────────

export interface SecretStore {
  /** Get a secret value */
  get(key: string): Promise<string | null>;

  /** Store a secret */
  set(key: string, value: string): Promise<void>;

  /** Delete a secret */
  delete(key: string): Promise<boolean>;

  /** Check if a secret exists */
  has(key: string): Promise<boolean>;
}

// ── In-memory implementation (for testing and lightweight use) ──────────

export class MemorySecretStore implements SecretStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}
