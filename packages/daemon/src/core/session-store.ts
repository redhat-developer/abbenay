/**
 * SessionStore — file-based session persistence.
 *
 * Each session is stored as `<id>.json` in the sessions directory.
 * An `index.json` file provides fast listing without reading every session file.
 *
 * Sessions are owned by a principal string (e.g. "local", "http:<hash>",
 * "consumer:apme"). Callers must filter/check ownership — see
 * resolveSessionOwner / assertSessionOwner.
 *
 * Core layer (no transport dependencies).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from './engines.js';

// ── Ownership ───────────────────────────────────────────────────────────

/** Owner for CLI / local unix-socket / unauthenticated-local access. */
export const LOCAL_SESSION_OWNER = 'local';

/** Optional HTTP sub-owner header (scopes sessions under the API token). */
export const SESSION_OWNER_HEADER = 'x-abbenay-session-owner';

const OWNER_CLAIM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Stable HTTP principal derived from the API token fingerprint.
 * Different tokens get different owners; the same token always matches.
 */
export function ownerIdFromHttpToken(token: string): string {
  const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
  return `http:${hash}`;
}

/**
 * Build the HTTP session owner from the API token and optional claim header.
 */
export function resolveHttpSessionOwner(
  apiToken: string,
  ownerClaim?: string | null,
): string {
  const base = ownerIdFromHttpToken(apiToken);
  const claim = ownerClaim?.trim().toLowerCase();
  if (claim && OWNER_CLAIM_RE.test(claim)) {
    return `${base}:${claim}`;
  }
  return base;
}

/** Normalize owner for a session (legacy sessions without owner → local). */
export function resolveSessionOwner(session: { owner?: string }): string {
  return session.owner?.trim() || LOCAL_SESSION_OWNER;
}

/**
 * Throw if the caller does not own the session.
 * Uses "not found" wording to avoid leaking existence across owners.
 */
export function assertSessionOwner(
  session: { id: string; owner?: string },
  owner: string,
): void {
  if (resolveSessionOwner(session) !== owner) {
    throw new Error(`Session not found: ${session.id}`);
  }
}

export function isValidOwnerClaim(claim: string): boolean {
  return OWNER_CLAIM_RE.test(claim.trim().toLowerCase());
}

// ── Data types ──────────────────────────────────────────────────────────

export interface Session {
  id: string;
  title: string;
  model: string;
  policy?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, string>;
  /**
   * Principal that owns this session (e.g. "local", "http:<hash>").
   * Missing on legacy sessions — treated as LOCAL_SESSION_OWNER.
   */
  owner?: string;
  parentSessionId?: string;
  forkPoint?: number;
  summary?: string;
  /** User-message count at which the summary was last generated. */
  summaryMessageCount?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  /** Principal that owns this session (legacy entries omit → treated as local). */
  owner?: string;
}

export interface SessionListOptions {
  model?: string;
  limit?: number;
  offset?: number;
  /** When set, only return sessions owned by this principal. */
  owner?: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  totalCount: number;
}

interface IndexFile {
  sessions: SessionSummary[];
}

// ── SessionStore ────────────────────────────────────────────────────────

export class SessionStore {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly sessionsDir: string) {}

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const locked = this.writeLock.then(fn, fn);
    this.writeLock = locked.then(
      () => undefined,
      () => undefined,
    );
    return locked;
  }

  async create(
    model: string,
    title?: string,
    policy?: string,
    metadata?: Record<string, string>,
    owner: string = LOCAL_SESSION_OWNER,
  ): Promise<Session> {
    return this.withWriteLock(async () => {
      await this.ensureDir();

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const sessionOwner = owner.trim() || LOCAL_SESSION_OWNER;

      const session: Session = {
        id,
        title: title || 'New Session',
        model,
        policy,
        messages: [],
        createdAt: now,
        updatedAt: now,
        metadata: metadata || {},
        owner: sessionOwner,
      };

      await this.writeSession(session);
      await this.addToIndex({
        id,
        title: session.title,
        model,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        owner: sessionOwner,
      });

      return session;
    });
  }

  async get(id: string, includeMessages = true): Promise<Session> {
    const filePath = this.sessionPath(id);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`Session not found: ${id}`);
    }

    const session = JSON.parse(raw) as Session;
    if (!includeMessages) {
      return { ...session, messages: [] };
    }
    return session;
  }

  /**
   * Get a session only if it belongs to `owner`.
   * Throws Session not found when missing or owned by someone else.
   */
  async getOwned(id: string, owner: string, includeMessages = true): Promise<Session> {
    const session = await this.get(id, includeMessages);
    assertSessionOwner(session, owner);
    return session;
  }

  async list(options?: SessionListOptions): Promise<SessionListResult> {
    const index = await this.readIndex();
    let sessions = index.sessions;

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (options?.owner !== undefined) {
      sessions = sessions.filter(
        (s) => resolveSessionOwner(s) === options.owner,
      );
    }

    if (options?.model) {
      sessions = sessions.filter((s) => s.model === options.model);
    }

    const totalCount = sessions.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? sessions.length;

    if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0 ||
        !Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
      throw new Error('Invalid pagination: offset and limit must be non-negative integers');
    }

    sessions = sessions.slice(offset, offset + limit);

    return { sessions, totalCount };
  }

  async delete(id: string): Promise<void> {
    return this.withWriteLock(async () => {
      const filePath = this.sessionPath(id);
      try {
        await fs.promises.access(filePath);
      } catch {
        throw new Error(`Session not found: ${id}`);
      }

      await fs.promises.unlink(filePath);
      await this.removeFromIndex(id);
    });
  }

  /** Delete only if owned by `owner`. */
  async deleteOwned(id: string, owner: string): Promise<void> {
    const session = await this.get(id, false);
    assertSessionOwner(session, owner);
    await this.delete(id);
  }

  async appendMessage(id: string, message: ChatMessage): Promise<Session> {
    return this.withWriteLock(async () => {
      const session = await this.get(id, true);
      session.messages.push(message);
      session.updatedAt = new Date().toISOString();

      await this.writeSession(session);
      await this.updateIndex(id, {
        messageCount: session.messages.length,
        updatedAt: session.updatedAt,
      });

      return session;
    });
  }

  async updateTitle(id: string, title: string): Promise<void> {
    return this.withWriteLock(async () => {
      const session = await this.get(id, true);
      session.title = title;
      session.updatedAt = new Date().toISOString();

      await this.writeSession(session);
      await this.updateIndex(id, { title, updatedAt: session.updatedAt });
    });
  }

  async updateSummary(id: string, summary: string, messageCount: number): Promise<void> {
    const session = await this.get(id, true);
    session.summary = summary;
    session.summaryMessageCount = messageCount;
    session.updatedAt = new Date().toISOString();

    await this.writeSession(session);
    await this.updateIndex(id, { summary, updatedAt: session.updatedAt });
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private static readonly VALID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private validateId(id: string): void {
    if (!SessionStore.VALID_ID.test(id)) {
      throw new Error(`Invalid session ID: ${id}`);
    }
  }

  private sessionPath(id: string): string {
    this.validateId(id);
    return path.join(this.sessionsDir, `${id}.json`);
  }

  private indexPath(): string {
    return path.join(this.sessionsDir, 'index.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  private async writeSession(session: Session): Promise<void> {
    const filePath = this.sessionPath(session.id);
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(session, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmpPath, filePath);
  }

  private async readIndex(): Promise<IndexFile> {
    try {
      const raw = await fs.promises.readFile(this.indexPath(), 'utf-8');
      return JSON.parse(raw) as IndexFile;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessions: [] };
      }
      throw err;
    }
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await this.ensureDir();
    const tmpPath = `${this.indexPath()}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(index, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmpPath, this.indexPath());
  }

  private async addToIndex(summary: SessionSummary): Promise<void> {
    const index = await this.readIndex();
    index.sessions.push(summary);
    await this.writeIndex(index);
  }

  private async removeFromIndex(id: string): Promise<void> {
    const index = await this.readIndex();
    index.sessions = index.sessions.filter((s) => s.id !== id);
    await this.writeIndex(index);
  }

  private async updateIndex(
    id: string,
    updates: Partial<SessionSummary>,
  ): Promise<void> {
    const index = await this.readIndex();
    const entry = index.sessions.find((s) => s.id === id);
    if (entry) {
      Object.assign(entry, updates);
      await this.writeIndex(index);
    }
  }
}
