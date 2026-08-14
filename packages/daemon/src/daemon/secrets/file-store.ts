/**
 * Filesystem-backed secret store.
 *
 * Persists a JSON map of key → value next to Abbenay config
 * (``<configDir>/secrets.json``, mode ``0o600``). Intended for containers
 * where the OS keychain is unavailable and process-lifetime memory is not
 * durable across restarts.
 *
 * Mutations are serialized per instance so concurrent set/delete calls cannot
 * clobber each other. The in-memory cache is updated only after a successful
 * atomic rename to disk.
 *
 * Never logs secret values.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { SecretStore } from '../../core/secrets.js';
import { getSecretsPath } from '../../core/paths.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class FileSecretStore implements SecretStore {
  private readonly filePath: string;
  private cache: Map<string, string> | null = null;
  /** Chains set/delete so concurrent writers apply in order. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath = filePath ?? getSecretsPath();
  }

  /** Absolute path used for persistence (tests / diagnostics). */
  get path(): string {
    return this.filePath;
  }

  private async ensureLoaded(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;

    const map = new Map<string, string>();
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') {
            map.set(key, value);
          }
        }
      } else {
        console.warn(
          `[Secrets] Ignoring non-object secrets file at ${this.filePath}; starting empty`,
        );
      }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        const loadError = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Secrets] Failed to read secrets file ${this.filePath}: ${loadError}; starting empty`,
        );
      }
    }

    this.cache = map;
    return map;
  }

  private async persist(map: Map<string, string>): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });

    const payload = JSON.stringify(Object.fromEntries(map), null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmpPath, payload, { encoding: 'utf8', mode: FILE_MODE });
      await fsp.rename(tmpPath, this.filePath);
      try {
        await fsp.chmod(this.filePath, FILE_MODE);
      } catch {
        // Windows and some FS ignore chmod; best-effort.
      }
    } catch (error: unknown) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // ignore cleanup failure
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to persist secrets file: ${msg}`);
    }
  }

  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op, op);
    // Keep the chain alive even if this op rejects (caller still sees the error).
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get(key: string): Promise<string | null> {
    const map = await this.ensureLoaded();
    return map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const next = new Map(await this.ensureLoaded());
      next.set(key, value);
      await this.persist(next);
      this.cache = next;
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const next = new Map(await this.ensureLoaded());
      const existed = next.delete(key);
      if (existed) {
        await this.persist(next);
        this.cache = next;
      }
      return existed;
    });
  }

  async has(key: string): Promise<boolean> {
    const map = await this.ensureLoaded();
    return map.has(key);
  }
}
