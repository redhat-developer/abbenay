/**
 * HTTP request body validation helpers.
 *
 * Every mutating web API route parses its body with a Zod schema via
 * `parseRequestBody`. Invalid bodies return HTTP 400 before business logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Response } from 'express';
import { z } from 'zod';
import type { DaemonState } from '../state.js';

/** Resolve to a real path when the target exists; otherwise path.resolve. */
function resolvePathKey(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Format a ZodError into a concise API error string.
 */
export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body';
  const loc = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `Invalid request body: ${loc}: ${issue.message}`;
}

/**
 * Parse `body` with `schema`. Never throws.
 */
export function parseRequestBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    return { success: false, error: formatZodError(result.error) };
  }
  return { success: true, data: result.data };
}

/**
 * Send a 400 JSON error for a validation failure. Returns true so callers
 * can `if (sendBadRequest(...)) return;`.
 */
export function sendBadRequest(res: Response, error: string): true {
  res.status(400).json({ error });
  return true;
}

/**
 * True when `location` contains a `..` path segment (Unix or Windows separators).
 */
export function containsPathTraversal(location: string): boolean {
  const normalized = location.replace(/\\/g, '/');
  return normalized.split('/').includes('..');
}

/**
 * Collect absolute workspace paths the daemon currently trusts
 * (connected VS Code workspaces + registered client workspace paths).
 */
export function collectAllowlistedWorkspaces(state: DaemonState): string[] {
  const set = new Set<string>();
  const add = (p?: string): void => {
    if (typeof p === 'string' && p.trim().length > 0 && !p.includes('\0')) {
      set.add(resolvePathKey(p));
    }
  };

  for (const w of state.getVSCodeWorkspaces()) {
    add(w);
  }
  for (const c of state.getClients()) {
    add(c.workspacePath);
    for (const wp of c.workspacePaths ?? []) {
      add(wp);
    }
  }
  return [...set];
}

export type WorkspaceLocationCheck =
  | { ok: true; resolved: string }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Validate a workspace config location against path-traversal rules and the
 * allowlisted set of connected workspace paths.
 *
 * - Traversal (`..`) → 400
 * - Outside allowlist → 403
 */
export function checkWorkspaceLocation(
  location: string,
  allowlisted: string[],
): WorkspaceLocationCheck {
  if (typeof location !== 'string' || location.trim().length === 0) {
    return { ok: false, status: 400, error: 'location must be a non-empty string' };
  }
  if (location.includes('\0')) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid location: null bytes are not allowed',
    };
  }
  if (containsPathTraversal(location)) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid location: path traversal is not allowed',
    };
  }

  const resolved = resolvePathKey(location);
  const allowed = new Set(allowlisted.map((p) => resolvePathKey(p)));
  if (!allowed.has(resolved)) {
    return {
      ok: false,
      status: 403,
      error: 'location is not an allowlisted workspace path',
    };
  }
  return { ok: true, resolved };
}

export type ConfigLocationResult =
  | { ok: true; kind: 'user' }
  | { ok: true; kind: 'workspace'; resolved: string }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Resolve a config `location` value: `'user'` or an allowlisted workspace path.
 */
export function resolveConfigLocation(
  location: string,
  state: DaemonState,
): ConfigLocationResult {
  if (location === 'user') {
    return { ok: true, kind: 'user' };
  }
  const allowlisted = collectAllowlistedWorkspaces(state);
  const check = checkWorkspaceLocation(location, allowlisted);
  if (!check.ok) return check;
  return { ok: true, kind: 'workspace', resolved: check.resolved };
}
