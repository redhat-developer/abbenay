/**
 * Tool approval validator unit tests
 *
 * Tests the shared 3-tier precedence logic (disabled > require_approval >
 * auto_approve > default ask) used by both chat and MCP HTTP.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry, type ToolPolicyConfig } from './tool-registry.js';
import {
  authorizeToolExecution,
  classifyToolPolicy,
  createToolValidator,
} from './tool-approval.js';

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register('github', 'mcp', [
    { name: 'search', description: 'Search repos', inputSchema: '{}' },
    { name: 'delete_repo', description: 'Delete a repo', inputSchema: '{}' },
  ]);
  reg.register('safe', 'mcp', [
    { name: 'read', description: 'Read a file', inputSchema: '{}' },
  ]);
  reg.register('agent', 'local', [
    { name: 'calculate', description: 'Calculate', inputSchema: '{}' },
  ]);
  return reg;
}

describe('Tool approval validator', () => {
  describe('default behavior (no policy)', () => {
    it('asks for all tools when no policy is configured', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const validator = createToolValidator(reg, undefined, onApproval);

      await validator('search', {});
      await validator('read', {});
      await validator('calculate', {});

      expect(onApproval).toHaveBeenCalledTimes(3);
    });

    it('asks for all tools with empty policy', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const validator = createToolValidator(reg, {}, onApproval);

      await validator('search', {});
      expect(onApproval).toHaveBeenCalledTimes(1);
    });

    it('denies ask-tier tools when no approval callback (fail-closed)', async () => {
      const reg = makeRegistry();
      const validator = createToolValidator(reg, undefined);
      expect(await validator('search', {})).toBe('deny');
    });
  });

  describe('disabled_tools tier', () => {
    it('denies tools matching disabled_tools without asking', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { disabled_tools: ['mcp:github/delete_repo'] };
      const validator = createToolValidator(reg, policy, onApproval);

      expect(await validator('delete_repo', {})).toBe('deny');
      expect(onApproval).not.toHaveBeenCalled();
    });

    it('disabled_tools overrides auto_approve', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = {
        auto_approve: ['mcp:*/*'],
        disabled_tools: ['mcp:github/delete_repo'],
      };
      const validator = createToolValidator(reg, policy, onApproval);

      expect(await validator('delete_repo', {})).toBe('deny');
      expect(await validator('search', {})).toBe('allow');
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  describe('auto_approve tier', () => {
    it('skips approval for tools matching auto_approve', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { auto_approve: ['mcp:safe/*'] };
      const validator = createToolValidator(reg, policy, onApproval);

      const decision = await validator('read', {});
      expect(decision).toBe('allow');
      expect(onApproval).not.toHaveBeenCalled();
    });

    it('still asks for tools NOT in auto_approve', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { auto_approve: ['mcp:safe/*'] };
      const validator = createToolValidator(reg, policy, onApproval);

      await validator('search', {});
      expect(onApproval).toHaveBeenCalledTimes(1);
    });
  });

  describe('require_approval overrides auto_approve', () => {
    it('asks even when tool matches both require_approval and auto_approve', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('deny');
      const policy: ToolPolicyConfig = {
        auto_approve: ['mcp:*/*'],
        require_approval: ['mcp:github/delete_repo'],
      };
      const validator = createToolValidator(reg, policy, onApproval);

      const decision = await validator('delete_repo', {});
      expect(decision).toBe('deny');
      expect(onApproval).toHaveBeenCalledTimes(1);
    });

    it('auto-approves tools that match auto_approve but NOT require_approval', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = {
        auto_approve: ['mcp:*/*'],
        require_approval: ['mcp:github/delete_repo'],
      };
      const validator = createToolValidator(reg, policy, onApproval);

      const decision = await validator('search', {});
      expect(decision).toBe('allow');
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  describe('backward compatibility: auto_approve all', () => {
    it('*:*/* auto-approves all namespaced tools', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { auto_approve: ['*:*/*'] };
      const validator = createToolValidator(reg, policy, onApproval);

      expect(await validator('search', {})).toBe('allow');
      expect(await validator('read', {})).toBe('allow');
      expect(await validator('calculate', {})).toBe('allow');
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  describe('namespacedName passthrough', () => {
    it('passes namespacedName to approval callback', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const validator = createToolValidator(reg, undefined, onApproval);

      await validator('search', { q: 'test' });
      expect(onApproval).toHaveBeenCalledWith(
        expect.any(String),
        'search',
        { q: 'test' },
        'mcp:github/search',
      );
    });

    it('passes namespacedName when tool is in require_approval', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { require_approval: ['mcp:github/*'] };
      const validator = createToolValidator(reg, policy, onApproval);

      await validator('search', {});
      expect(onApproval).toHaveBeenCalledWith(
        expect.any(String),
        'search',
        {},
        'mcp:github/search',
      );
    });
  });

  describe('deny and abort decisions', () => {
    it('propagates deny from callback', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('deny');
      const validator = createToolValidator(reg, undefined, onApproval);

      expect(await validator('search', {})).toBe('deny');
    });

    it('propagates abort from callback', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('abort');
      const validator = createToolValidator(reg, undefined, onApproval);

      expect(await validator('search', {})).toBe('abort');
    });
  });

  describe('classifyToolPolicy', () => {
    it('classifies each tier', () => {
      const policy: ToolPolicyConfig = {
        disabled_tools: ['mcp:github/delete_repo'],
        require_approval: ['mcp:github/search'],
        auto_approve: ['mcp:safe/*'],
      };
      expect(classifyToolPolicy('mcp:github/delete_repo', policy)).toBe('disabled');
      expect(classifyToolPolicy('mcp:github/search', policy)).toBe('require_approval');
      expect(classifyToolPolicy('mcp:safe/read', policy)).toBe('auto_approve');
      expect(classifyToolPolicy('local:agent/calculate', policy)).toBe('default_ask');
    });
  });

  describe('authorizeToolExecution', () => {
    it('returns disabled message for disabled tools', async () => {
      const reg = makeRegistry();
      const result = await authorizeToolExecution(
        reg,
        { disabled_tools: ['mcp:github/search'] },
        'search',
        {},
      );
      expect(result.decision).toBe('deny');
      expect(result.message).toMatch(/disabled/);
    });

    it('allows auto_approve tools', async () => {
      const reg = makeRegistry();
      const result = await authorizeToolExecution(
        reg,
        { auto_approve: ['mcp:safe/*'] },
        'read',
        {},
      );
      expect(result.decision).toBe('allow');
      expect(result.message).toBeUndefined();
    });
  });
});
