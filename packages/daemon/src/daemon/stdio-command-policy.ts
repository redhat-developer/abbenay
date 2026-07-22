/**
 * Stdio MCP command allowlist + denial helpers (DR-043 / finding H6).
 *
 * Dynamic RegisterMcpServer with transport=stdio must not spawn arbitrary
 * binaries. Commands are matched against security.stdio_command_allowlist
 * (basename or absolute path). Empty allowlist denies all dynamic stdio.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class StdioCommandDeniedError extends Error {
  readonly code = 'STDIO_COMMAND_DENIED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'StdioCommandDeniedError';
  }
}

/**
 * True when `command` is permitted by the allowlist.
 * Entries may be basenames (`npx`) or absolute paths (`/usr/bin/npx`).
 * An empty allowlist matches nothing (fail-closed for dynamic stdio).
 */
export function isStdioCommandAllowlisted(
  command: string | undefined,
  allowlist: string[] | undefined,
): boolean {
  if (!command || !command.trim()) return false;
  const list = (allowlist || []).map((e) => e.trim()).filter(Boolean);
  if (list.length === 0) return false;

  const normalized = command.trim();
  if (normalized.includes('\0')) return false;

  const base = path.basename(normalized);

  for (const entry of list) {
    if (entry === normalized || entry === base) {
      return true;
    }
    if (path.isAbsolute(entry) && path.isAbsolute(normalized)) {
      try {
        if (fs.realpathSync(entry) === fs.realpathSync(normalized)) {
          return true;
        }
      } catch {
        // Path may not exist yet; fall through to string equality above.
      }
    }
  }
  return false;
}

/**
 * Assert command is allowlisted. Throws StdioCommandDeniedError with a clear
 * operator-facing reason when denied.
 */
export function assertStdioCommandAllowlisted(
  command: string | undefined,
  allowlist: string[] | undefined,
  context: { serverId?: string; source?: 'dynamic' | 'config' } = {},
): void {
  const serverHint = context.serverId ? ` for MCP server '${context.serverId}'` : '';
  if (!command || !command.trim()) {
    throw new StdioCommandDeniedError(
      `stdio transport requires a command${serverHint}`,
    );
  }
  const list = allowlist || [];
  if (list.length === 0) {
    throw new StdioCommandDeniedError(
      `stdio command "${command}" denied${serverHint}: ` +
        'security.stdio_command_allowlist is empty. Add permitted binaries ' +
        '(e.g. npx, uvx) to config.yaml before dynamic stdio registration.',
    );
  }
  if (!isStdioCommandAllowlisted(command, list)) {
    throw new StdioCommandDeniedError(
      `stdio command "${command}" denied${serverHint}: not in ` +
        `security.stdio_command_allowlist ([${list.join(', ')}]). ` +
        'No process was spawned.',
    );
  }
}

/** Format a denial for logs / UI (single line). */
export function formatStdioDenial(reason: string): string {
  return `[StdioMCP] DENIED: ${reason}`;
}
