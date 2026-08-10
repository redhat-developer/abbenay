import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRouter } from './tool-router.js';
import type { RegisteredTool } from '../core/tool-registry.js';

function makeTool(
  sourceType: RegisteredTool['sourceType'],
  overrides: Partial<RegisteredTool> = {},
): RegisteredTool {
  return {
    namespacedName: `test:${sourceType}/tool`,
    source: `test:${sourceType}`,
    sourceType,
    originalName: 'tool',
    description: 'test tool',
    inputSchema: '{}',
    ...overrides,
  };
}

describe('ToolRouter.buildFallbackExecutor', () => {
  let router: ToolRouter;

  beforeEach(() => {
    router = new ToolRouter();
  });

  it('routes vscode tools to VS Code invoker', async () => {
    const invoker = vi.fn().mockResolvedValue({
      resultJson: '{"ok":true}',
      isError: false,
    });
    router.setVSCodeInvoker(invoker);

    const executor = router.buildFallbackExecutor();
    const result = await executor(makeTool('vscode'), { arg: 1 });

    expect(invoker).toHaveBeenCalledWith('tool', { arg: 1 });
    expect(result).toEqual({ ok: true });
  });

  it('returns vscode error payload when isError is true', async () => {
    router.setVSCodeInvoker(
      vi.fn().mockResolvedValue({ resultJson: 'failed', isError: true }),
    );

    const result = await router.buildFallbackExecutor()(makeTool('vscode'), {});
    expect(result).toEqual({ error: 'failed' });
  });

  it('returns raw string when vscode result is not JSON', async () => {
    router.setVSCodeInvoker(
      vi.fn().mockResolvedValue({ resultJson: 'plain text', isError: false }),
    );

    const result = await router.buildFallbackExecutor()(makeTool('vscode'), {});
    expect(result).toBe('plain text');
  });

  it('throws when vscode invoker is not wired', async () => {
    await expect(
      router.buildFallbackExecutor()(makeTool('vscode'), {}),
    ).rejects.toThrow('No VS Code connection available');
  });

  it('routes mcp tools to MCP caller', async () => {
    const caller = vi.fn().mockResolvedValue({ data: 42 });
    router.setMcpCaller(caller);

    const tool = makeTool('mcp', { source: 'mcp:github', originalName: 'search' });
    const result = await router.buildFallbackExecutor()(tool, { q: 'test' });

    expect(caller).toHaveBeenCalledWith('mcp:github', 'search', { q: 'test' });
    expect(result).toEqual({ data: 42 });
  });

  it('throws when mcp caller is not wired', async () => {
    await expect(
      router.buildFallbackExecutor()(makeTool('mcp'), {}),
    ).rejects.toThrow('No MCP client pool available');
  });

  it('throws for local tools without inline executor', async () => {
    await expect(
      router.buildFallbackExecutor()(makeTool('local'), {}),
    ).rejects.toThrow('Local tool "tool" has no inline executor');
  });

  it('throws for unknown source types', async () => {
    const tool = makeTool('vscode');
    (tool as { sourceType: string }).sourceType = 'unknown' as RegisteredTool['sourceType'];

    await expect(
      router.buildFallbackExecutor()(tool, {}),
    ).rejects.toThrow('Unknown tool source type: unknown');
  });
});
