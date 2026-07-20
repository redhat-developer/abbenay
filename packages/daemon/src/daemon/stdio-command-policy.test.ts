/**
 * Stdio MCP command allowlist unit tests (DR-038 / H6)
 */

import { describe, it, expect } from 'vitest';
import {
  assertStdioCommandAllowlisted,
  isStdioCommandAllowlisted,
  StdioCommandDeniedError,
} from './stdio-command-policy.js';

describe('isStdioCommandAllowlisted', () => {
  it('denies when allowlist is empty or missing', () => {
    expect(isStdioCommandAllowlisted('npx', [])).toBe(false);
    expect(isStdioCommandAllowlisted('npx', undefined)).toBe(false);
    expect(isStdioCommandAllowlisted('/bin/sh', [])).toBe(false);
  });

  it('matches basename allowlist entries', () => {
    expect(isStdioCommandAllowlisted('npx', ['npx', 'uvx'])).toBe(true);
    expect(isStdioCommandAllowlisted('/usr/bin/npx', ['npx'])).toBe(true);
    expect(isStdioCommandAllowlisted('/bin/sh', ['npx'])).toBe(false);
  });

  it('matches absolute path allowlist entries', () => {
    expect(isStdioCommandAllowlisted('/usr/local/bin/my-mcp', ['/usr/local/bin/my-mcp'])).toBe(true);
    expect(isStdioCommandAllowlisted('/usr/local/bin/other', ['/usr/local/bin/my-mcp'])).toBe(false);
  });

  it('rejects empty command and null bytes', () => {
    expect(isStdioCommandAllowlisted('', ['npx'])).toBe(false);
    expect(isStdioCommandAllowlisted('  ', ['npx'])).toBe(false);
    expect(isStdioCommandAllowlisted('npx\0evil', ['npx'])).toBe(false);
  });
});

describe('assertStdioCommandAllowlisted', () => {
  it('throws StdioCommandDeniedError for /bin/sh when not allowlisted', () => {
    expect(() =>
      assertStdioCommandAllowlisted('/bin/sh', ['npx'], { serverId: 'evil' }),
    ).toThrow(StdioCommandDeniedError);
    expect(() =>
      assertStdioCommandAllowlisted('/bin/sh', ['npx'], { serverId: 'evil' }),
    ).toThrow(/not in security\.stdio_command_allowlist/);
  });

  it('throws clear message when allowlist is empty', () => {
    expect(() =>
      assertStdioCommandAllowlisted('npx', [], { serverId: 'x' }),
    ).toThrow(/stdio_command_allowlist is empty/);
  });

  it('passes for allowlisted command', () => {
    expect(() =>
      assertStdioCommandAllowlisted('npx', ['npx', 'uvx'], { serverId: 'ok' }),
    ).not.toThrow();
  });
});
