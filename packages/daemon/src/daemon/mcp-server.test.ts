/**
 * AbbenayMcpServer unit tests — tool_policy enforcement on MCP execution.
 *
 * Verifies authorizeAndExecute uses the same createToolValidator path as chat:
 * disabled → deny, require_approval → wait for consent, auto_approve → run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../core/tool-registry.js';
import { ToolRouter } from './tool-router.js';
import { AbbenayMcpServer } from './mcp-server.js';

describe('AbbenayMcpServer authorizeAndExecute', () => {
  let registry: ToolRegistry;
  let router: ToolRouter;
  let server: AbbenayMcpServer;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    executor = vi.fn().mockResolvedValue({ ok: true });
    registry.register('agent', 'local', [
      {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: JSON.stringify({ type: 'object', properties: {} }),
        executor,
      },
      {
        name: 'danger',
        description: 'Dangerous tool',
        inputSchema: JSON.stringify({ type: 'object', properties: {} }),
        executor,
      },
    ]);
    router = new ToolRouter();
    server = new AbbenayMcpServer(registry, router);
  });

  function tool(name: string) {
    const t = registry.resolve(name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  }

  it('rejects disabled_tools without executing', async () => {
    server.configure({
      getPolicy: () => ({ disabled_tools: ['local:agent/danger'] }),
      onApprovalNeeded: vi.fn().mockResolvedValue('allow'),
    });

    const result = await server.authorizeAndExecute(tool('danger'), { x: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('runs auto_approve tools without asking', async () => {
    const onApproval = vi.fn().mockResolvedValue('allow');
    server.configure({
      getPolicy: () => ({ auto_approve: ['local:agent/echo'] }),
      onApprovalNeeded: onApproval,
    });

    const result = await server.authorizeAndExecute(tool('echo'), { msg: 'hi' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('ok');
    expect(onApproval).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledWith({ msg: 'hi' });
  });

  it('blocks require_approval until callback allows', async () => {
    let resolveApproval!: (d: 'allow' | 'deny' | 'abort') => void;
    const approvalPromise = new Promise<'allow' | 'deny' | 'abort'>((r) => {
      resolveApproval = r;
    });
    const onApproval = vi.fn().mockReturnValue(approvalPromise);

    server.configure({
      getPolicy: () => ({
        auto_approve: ['local:agent/*'],
        require_approval: ['local:agent/danger'],
      }),
      onApprovalNeeded: onApproval,
    });

    const execPromise = server.authorizeAndExecute(tool('danger'), {});
    // Not executed yet
    await Promise.resolve();
    expect(executor).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenCalled();

    resolveApproval('allow');
    const result = await execPromise;
    expect(result.isError).toBeUndefined();
    expect(executor).toHaveBeenCalled();
  });

  it('does not run when require_approval is denied', async () => {
    server.configure({
      getPolicy: () => ({ require_approval: ['local:agent/echo'] }),
      onApprovalNeeded: vi.fn().mockResolvedValue('deny'),
    });

    const result = await server.authorizeAndExecute(tool('echo'), {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/denied/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('default-ask denies when no approval handler (fail-closed)', async () => {
    server.configure({
      getPolicy: () => ({}),
    });

    const result = await server.authorizeAndExecute(tool('echo'), {});
    expect(result.isError).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it('auto_approve only when policy allows — unmatched tools still ask', async () => {
    const onApproval = vi.fn().mockResolvedValue('deny');
    server.configure({
      getPolicy: () => ({ auto_approve: ['local:agent/echo'] }),
      onApprovalNeeded: onApproval,
    });

    const denied = await server.authorizeAndExecute(tool('danger'), {});
    expect(denied.isError).toBe(true);
    expect(onApproval).toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  describe('connection consent helpers', () => {
    it('rememberClient / forgetClient manage the allowlist', () => {
      server.rememberClient('claude-desktop');
      expect(server.listRememberedClients()).toContain('claude-desktop');
      server.forgetClient('claude-desktop');
      expect(server.listRememberedClients()).not.toContain('claude-desktop');
    });

    it('refuses to remember unknown-client or empty names', () => {
      server.rememberClient('unknown-client');
      server.rememberClient('');
      server.rememberClient('   ');
      expect(server.listRememberedClients()).toEqual([]);
    });
  });
});
