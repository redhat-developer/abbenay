/**
 * Unit tests for ConfigFile / PolicyConfig Zod schemas.
 */

import { describe, it, expect } from 'vitest';
import {
  ConfigFileSchema,
  PolicyConfigSchema,
  parseConfigFile,
  VirtualNameSchema,
} from './config-schema.js';

describe('VirtualNameSchema', () => {
  it('accepts valid virtual names', () => {
    expect(VirtualNameSchema.safeParse('openai').success).toBe(true);
    expect(VirtualNameSchema.safeParse('my-provider_v2').success).toBe(true);
  });

  it('rejects uppercase, spaces, and slashes', () => {
    expect(VirtualNameSchema.safeParse('OpenAI').success).toBe(false);
    expect(VirtualNameSchema.safeParse('my provider').success).toBe(false);
    expect(VirtualNameSchema.safeParse('a/b').success).toBe(false);
  });
});

describe('ConfigFileSchema', () => {
  it('accepts a minimal valid config', () => {
    const result = parseConfigFile({ providers: {} });
    expect(result.success).toBe(true);
  });

  it('accepts a full provider + models shape', () => {
    const result = parseConfigFile({
      providers: {
        openai: {
          engine: 'openai',
          models: {
            'gpt-4o': { temperature: 0.2, max_tokens: 1024 },
          },
        },
      },
      tool_policy: { auto_approve: ['mcp:safe/*'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys (field injection)', () => {
    const withEvil = ConfigFileSchema.safeParse({ providers: {}, evil: true });
    expect(withEvil.success).toBe(false);
  });

  it('rejects wrong types for required provider fields', () => {
    const result = parseConfigFile({
      providers: {
        openai: { engine: 42 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range temperature', () => {
    const result = parseConfigFile({
      providers: {
        openai: {
          engine: 'openai',
          models: { 'gpt-4o': { temperature: 9 } },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts openai_compat tools passthrough (DR-032)', () => {
    const result = parseConfigFile({
      providers: {},
      openai_compat: { tools: 'passthrough' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts per-model openai_compat_tools override', () => {
    const result = parseConfigFile({
      providers: {
        openai: {
          engine: 'openai',
          models: { 'gpt-4o': { openai_compat_tools: 'passthrough' } },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid openai_compat.tools values', () => {
    const result = parseConfigFile({
      openai_compat: { tools: 'auto' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys under openai_compat', () => {
    const result = ConfigFileSchema.safeParse({
      openai_compat: { tools: 'passthrough', evil: true },
    });
    expect(result.success).toBe(false);
  });

  it('accepts security.stdio_command_allowlist (DR-038)', () => {
    const result = parseConfigFile({
      security: {
        max_dynamic_mcp_servers: 5,
        stdio_command_allowlist: ['npx', '/usr/local/bin/my-mcp'],
        stdio_require_approval: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.security?.stdio_command_allowlist).toEqual([
        'npx',
        '/usr/local/bin/my-mcp',
      ]);
    }
  });

  it('rejects unknown keys under security', () => {
    const result = ConfigFileSchema.safeParse({
      security: { stdio_command_allowlist: ['npx'], evil: true },
    });
    expect(result.success).toBe(false);
  });
});

describe('PolicyConfigSchema', () => {
  it('accepts nested policy fields', () => {
    const result = PolicyConfigSchema.safeParse({
      sampling: { temperature: 0.3 },
      output: { format: 'json_only', max_tokens: 512 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid format enum', () => {
    const result = PolicyConfigSchema.safeParse({
      output: { format: 'xml' },
    });
    expect(result.success).toBe(false);
  });
});
