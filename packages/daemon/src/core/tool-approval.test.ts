/**
 * Tool approval validator unit tests
 *
 * Tests the 3-tier precedence logic (require_approval > auto_approve > default ask)
 * that is built inside CoreState.chat(). Exercises the validator construction
 * directly against ToolRegistry + matchesAnyPattern to verify tier ordering,
 * namespacedName passthrough, and backward compatibility.
 */

import { describe, it, expect, vi } from 'vitest';
import { matchesAnyPattern, ToolRegistry, type ToolPolicyConfig } from './tool-registry.js';

type ApprovalDecision = 'allow' | 'deny' | 'abort';

/**
 * Build a tool validator using the same logic as state.ts.
 * This is extracted here to test in isolation without mocking the full chat flow.
 */
function buildValidator(
  registry: ToolRegistry,
  policy: ToolPolicyConfig | undefined,
  onApprovalNeeded: (requestId: string, toolName: string, args: unknown, namespacedName?: string) => Promise<ApprovalDecision>,
) {
  const requirePatterns = policy?.require_approval;
  const autoPatterns = policy?.auto_approve;

  return async (toolName: string, args: unknown): Promise<ApprovalDecision> => {
    const resolved = registry.resolve(toolName);
    const nsName = resolved?.namespacedName || toolName;

    if (matchesAnyPattern(requirePatterns, nsName)) {
      return onApprovalNeeded('req-id', toolName, args, nsName);
    }

    if (matchesAnyPattern(autoPatterns, nsName)) {
      return 'allow';
    }

    return onApprovalNeeded('req-id', toolName, args, nsName);
  };
}

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
      const validator = buildValidator(reg, undefined, onApproval);

      await validator('search', {});
      await validator('read', {});
      await validator('calculate', {});

      expect(onApproval).toHaveBeenCalledTimes(3);
    });

    it('asks for all tools with empty policy', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const validator = buildValidator(reg, {}, onApproval);

      await validator('search', {});
      expect(onApproval).toHaveBeenCalledTimes(1);
    });
  });

  describe('auto_approve tier', () => {
    it('skips approval for tools matching auto_approve', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { auto_approve: ['mcp:safe/*'] };
      const validator = buildValidator(reg, policy, onApproval);

      const decision = await validator('read', {});
      expect(decision).toBe('allow');
      expect(onApproval).not.toHaveBeenCalled();
    });

    it('still asks for tools NOT in auto_approve', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { auto_approve: ['mcp:safe/*'] };
      const validator = buildValidator(reg, policy, onApproval);

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
      const validator = buildValidator(reg, policy, onApproval);

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
      const validator = buildValidator(reg, policy, onApproval);

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
      const validator = buildValidator(reg, policy, onApproval);

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
      const validator = buildValidator(reg, undefined, onApproval);

      await validator('search', { q: 'test' });
      expect(onApproval).toHaveBeenCalledWith(
        'req-id',
        'search',
        { q: 'test' },
        'mcp:github/search',
      );
    });

    it('passes namespacedName when tool is in require_approval', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('allow');
      const policy: ToolPolicyConfig = { require_approval: ['mcp:github/*'] };
      const validator = buildValidator(reg, policy, onApproval);

      await validator('search', {});
      expect(onApproval).toHaveBeenCalledWith(
        'req-id',
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
      const validator = buildValidator(reg, undefined, onApproval);

      expect(await validator('search', {})).toBe('deny');
    });

    it('propagates abort from callback', async () => {
      const reg = makeRegistry();
      const onApproval = vi.fn().mockResolvedValue('abort');
      const validator = buildValidator(reg, undefined, onApproval);

      expect(await validator('search', {})).toBe('abort');
    });
  });
});
