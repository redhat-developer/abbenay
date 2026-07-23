/**
 * Secret store interface and in-memory implementation.
 *
 * Core consumers inject their own SecretStore implementation.
 * The daemon uses KeychainSecretStore (keytar); tests use MemorySecretStore.
 *
 * Credential aggregation (finding A1): one daemon may hold many provider keys.
 * Mutating APIs must stay auth-gated; use {@link auditSecretChange} so operators
 * can detect unexpected writes. Never log secret values.
 */

import { sanitizeForLog } from './audit-log.js';

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

export interface SecretAuditEvent {
  /** Secret key name only — never the value */
  key: string;
  op: 'set' | 'delete';
  /** http-secrets | grpc-secrets | http-configure | grpc-configure | core-add */
  source: string;
  actor?: string;
}

/**
 * Emit an audit log line for a secret mutation (A1 accountability).
 * Never logs the secret value.
 */
export function auditSecretChange(event: SecretAuditEvent): void {
  const safeKey = sanitizeForLog(event.key);
  const actor = event.actor ? ` actor=${sanitizeForLog(event.actor)}` : '';
  console.info(
    `[Audit] secret changed: key=${safeKey} op=${event.op} ` +
      `source=${sanitizeForLog(event.source)}${actor}`,
  );
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
