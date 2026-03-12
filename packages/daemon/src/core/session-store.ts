/**
 * SessionStore — file-based session persistence.
 *
 * Each session is stored as `<id>.json` in the sessions directory.
 * An `index.json` file provides fast listing without reading every session file.
 *
 * Core layer (no transport dependencies).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from './engines.js';

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
  parentSessionId?: string;
  forkPoint?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListOptions {
  model?: string;
  limit?: number;
  offset?: number;
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
  constructor(private readonly sessionsDir: string) {}

  async create(
    model: string,
    title?: string,
    policy?: string,
    metadata?: Record<string, string>,
  ): Promise<Session> {
    await this.ensureDir();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const session: Session = {
      id,
      title: title || 'New Session',
      model,
      policy,
      messages: [],
      createdAt: now,
      updatedAt: now,
      metadata: metadata || {},
    };

    await this.writeSession(session);
    await this.addToIndex({
      id,
      title: session.title,
      model,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return session;
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

  async list(options?: SessionListOptions): Promise<SessionListResult> {
    const index = await this.readIndex();
    let sessions = index.sessions;

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (options?.model) {
      sessions = sessions.filter((s) => s.model === options.model);
    }

    const totalCount = sessions.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || sessions.length;

    sessions = sessions.slice(offset, offset + limit);

    return { sessions, totalCount };
  }

  async delete(id: string): Promise<void> {
    const filePath = this.sessionPath(id);
    try {
      await fs.promises.access(filePath);
    } catch {
      throw new Error(`Session not found: ${id}`);
    }

    await fs.promises.unlink(filePath);
    await this.removeFromIndex(id);
  }

  async appendMessage(id: string, message: ChatMessage): Promise<Session> {
    const session = await this.get(id, true);
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();

    await this.writeSession(session);
    await this.updateIndex(id, {
      messageCount: session.messages.length,
      updatedAt: session.updatedAt,
    });

    return session;
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const session = await this.get(id, true);
    session.title = title;
    session.updatedAt = new Date().toISOString();

    await this.writeSession(session);
    await this.updateIndex(id, { title, updatedAt: session.updatedAt });
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private sessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  private indexPath(): string {
    return path.join(this.sessionsDir, 'index.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });
  }

  private async writeSession(session: Session): Promise<void> {
    const filePath = this.sessionPath(session.id);
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(session, null, 2));
    await fs.promises.rename(tmpPath, filePath);
  }

  private async readIndex(): Promise<IndexFile> {
    try {
      const raw = await fs.promises.readFile(this.indexPath(), 'utf-8');
      return JSON.parse(raw) as IndexFile;
    } catch {
      return { sessions: [] };
    }
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await this.ensureDir();
    const tmpPath = `${this.indexPath()}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(index, null, 2));
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
