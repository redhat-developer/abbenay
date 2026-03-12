/**
 * Tool registry unit tests
 *
 * Tests glob matching (segment boundaries, wildcards), tool registration
 * and resolution, listForChat with policy filters, and alias handling.
 */

import { describe, it, expect } from 'vitest';
import { matchesAnyPattern, ToolRegistry, type ToolPolicyConfig } from './tool-registry.js';

// ── matchesAnyPattern / globMatch ──────────────────────────────────────

describe('matchesAnyPattern', () => {
  it('returns false for undefined patterns', () => {
    expect(matchesAnyPattern(undefined, 'mcp:github/search')).toBe(false);
  });

  it('returns false for empty patterns array', () => {
    expect(matchesAnyPattern([], 'mcp:github/search')).toBe(false);
  });

  it('matches exact namespaced name', () => {
    expect(matchesAnyPattern(['mcp:github/search'], 'mcp:github/search')).toBe(true);
  });

  it('does not match different tool', () => {
    expect(matchesAnyPattern(['mcp:github/search'], 'mcp:github/list')).toBe(false);
  });

  describe('wildcard segment boundaries', () => {
    it('bare * does NOT match names with /', () => {
      expect(matchesAnyPattern(['*'], 'mcp:github/search')).toBe(false);
    });

    it('bare * matches single segments (no /) including colons', () => {
      expect(matchesAnyPattern(['*'], 'mcp:github')).toBe(true);
    });

    it('mcp:github/* matches any tool under mcp:github', () => {
      expect(matchesAnyPattern(['mcp:github/*'], 'mcp:github/search')).toBe(true);
      expect(matchesAnyPattern(['mcp:github/*'], 'mcp:github/list_repos')).toBe(true);
    });

    it('mcp:github/* does NOT match other sources', () => {
      expect(matchesAnyPattern(['mcp:github/*'], 'mcp:other/search')).toBe(false);
    });

    it('mcp:*/* matches all MCP tools', () => {
      expect(matchesAnyPattern(['mcp:*/*'], 'mcp:github/search')).toBe(true);
      expect(matchesAnyPattern(['mcp:*/*'], 'mcp:filesystem/readFile')).toBe(true);
    });

    it('mcp:*/* does NOT match non-MCP tools', () => {
      expect(matchesAnyPattern(['mcp:*/*'], 'ws:project/readFile')).toBe(false);
      expect(matchesAnyPattern(['mcp:*/*'], 'local:agent/fn')).toBe(false);
    });

    it('*:*/* matches all namespaced tools', () => {
      expect(matchesAnyPattern(['*:*/*'], 'mcp:github/search')).toBe(true);
      expect(matchesAnyPattern(['*:*/*'], 'ws:project/readFile')).toBe(true);
      expect(matchesAnyPattern(['*:*/*'], 'local:agent/fn')).toBe(true);
    });

    it('ws:*/readFile matches readFile from any workspace', () => {
      expect(matchesAnyPattern(['ws:*/readFile'], 'ws:proj1/readFile')).toBe(true);
      expect(matchesAnyPattern(['ws:*/readFile'], 'ws:proj2/readFile')).toBe(true);
      expect(matchesAnyPattern(['ws:*/readFile'], 'ws:proj1/writeFile')).toBe(false);
    });
  });

  it('matches if ANY pattern in the list matches', () => {
    const patterns = ['mcp:github/*', 'local:agent/*'];
    expect(matchesAnyPattern(patterns, 'mcp:github/search')).toBe(true);
    expect(matchesAnyPattern(patterns, 'local:agent/fn')).toBe(true);
    expect(matchesAnyPattern(patterns, 'ws:project/readFile')).toBe(false);
  });
});

// ── ToolRegistry ───────────────────────────────────────────────────────

function makeTool(name: string, desc = '') {
  return { name, description: desc, inputSchema: '{}' };
}

describe('ToolRegistry', () => {
  describe('register and resolve', () => {
    it('namespaces MCP tools as mcp:sourceId/toolName', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search')]);
      const tool = reg.resolve('search');
      expect(tool).not.toBeNull();
      expect(tool!.namespacedName).toBe('mcp:github/search');
      expect(tool!.source).toBe('mcp:github');
      expect(tool!.sourceType).toBe('mcp');
      expect(tool!.originalName).toBe('search');
    });

    it('namespaces VS Code tools as ws:sourceId/toolName', () => {
      const reg = new ToolRegistry();
      reg.register('myproject', 'vscode', [makeTool('readFile')]);
      const tool = reg.resolve('readFile');
      expect(tool!.namespacedName).toBe('ws:myproject/readFile');
    });

    it('namespaces local tools as local:sourceId/toolName', () => {
      const reg = new ToolRegistry();
      reg.register('agent', 'local', [makeTool('doStuff')]);
      const tool = reg.resolve('doStuff');
      expect(tool!.namespacedName).toBe('local:agent/doStuff');
    });

    it('resolves by namespaced name', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search')]);
      const tool = reg.resolve('mcp:github/search');
      expect(tool).not.toBeNull();
      expect(tool!.originalName).toBe('search');
    });

    it('resolves by alias', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search_repositories')]);
      reg.setAliases({ search: 'mcp:github/search_repositories' });
      const tool = reg.resolve('search');
      expect(tool).not.toBeNull();
      expect(tool!.namespacedName).toBe('mcp:github/search_repositories');
    });

    it('returns null for unknown tool', () => {
      const reg = new ToolRegistry();
      expect(reg.resolve('nonexistent')).toBeNull();
    });
  });

  describe('listForChat', () => {
    it('returns all tools with no policy', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search'), makeTool('list')]);
      const tools = reg.listForChat();
      expect(tools).toHaveLength(2);
    });

    it('filters out disabled_tools by pattern', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search'), makeTool('delete')]);
      const policy: ToolPolicyConfig = { disabled_tools: ['mcp:github/delete'] };
      const tools = reg.listForChat(policy);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search');
    });

    it('filters out disabled_tools by wildcard pattern', () => {
      const reg = new ToolRegistry();
      reg.register('dangerous', 'mcp', [makeTool('rm'), makeTool('rmdir')]);
      reg.register('safe', 'mcp', [makeTool('read')]);
      const policy: ToolPolicyConfig = { disabled_tools: ['mcp:dangerous/*'] };
      const tools = reg.listForChat(policy);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('read');
    });

    it('uses alias as LLM-facing name when set', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search_repositories')]);
      reg.setAliases({ search: 'mcp:github/search_repositories' });
      const tools = reg.listForChat();
      expect(tools[0].name).toBe('search');
    });
  });

  describe('unregisterSource', () => {
    it('removes all tools from a source', () => {
      const reg = new ToolRegistry();
      reg.register('github', 'mcp', [makeTool('search'), makeTool('list')]);
      reg.register('safe', 'mcp', [makeTool('read')]);
      expect(reg.size).toBe(3);
      reg.unregisterSource('mcp:github');
      expect(reg.size).toBe(1);
      expect(reg.resolve('search')).toBeNull();
      expect(reg.resolve('read')).not.toBeNull();
    });
  });
});
