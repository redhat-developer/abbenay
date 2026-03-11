/**
 * ToolRegistry — transport-agnostic tool collection and namespacing.
 *
 * Part of @abbenay/core. Usable by both the daemon and standalone library consumers.
 *
 * Tools are collected from multiple sources (VS Code workspaces, MCP servers,
 * agent-registered local tools) and namespaced to prevent collisions.
 *
 * Two consumer profiles:
 *
 * 1. Simple agent — registers tools with executors, uses buildExecutor() + CoreState.chat()
 *    to let the AI SDK handle the tool loop automatically.
 *
 * 2. Advanced agent — uses passthrough mode, receives tool-call chunks in the stream,
 *    and owns the orchestration loop.
 */

import type { ToolDefinition, ToolExecutor } from './engines.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Source types for routing decisions */
export type ToolSourceType = 'vscode' | 'mcp' | 'local';

/**
 * A tool registered in the registry with full namespace metadata.
 */
export interface RegisteredTool {
  /** Fully namespaced name: "ws:myproject/readFile", "mcp:github/search", "local:myAgent/fn" */
  namespacedName: string;
  /** Source identifier: "ws:myproject", "mcp:github", "local:myAgent" */
  source: string;
  /** Source type for routing decisions */
  sourceType: ToolSourceType;
  /** Original un-namespaced tool name: "readFile" */
  originalName: string;
  /** Tool description for the LLM */
  description: string;
  /** JSON Schema string for the tool's input */
  inputSchema: string;
  /** Optional executor — only for 'local' tools registered by library consumers */
  executor?: (args: Record<string, any>) => Promise<any>;
}

/**
 * Input format for registering tools. Callers provide these,
 * the registry adds namespace metadata.
 */
export interface ToolRegistrationInput {
  name: string;
  description: string;
  inputSchema: string;
  /** Optional inline executor (only meaningful for 'local' source tools) */
  executor?: (args: Record<string, any>) => Promise<any>;
}

/**
 * Tool policy configuration — controls which tools the LLM sees and how they're approved.
 * Patterns support simple glob matching with '*' wildcards.
 */
export interface ToolPolicyConfig {
  /** Max tool execution rounds per chat (default 10) */
  max_tool_iterations?: number;
  /** Tier 1: execute without user confirmation (glob patterns) */
  auto_approve?: string[];
  /** Tier 2: pause chat, ask user (glob patterns) */
  require_approval?: string[];
  /** Tier 3: never register with LLM (glob patterns) */
  disabled_tools?: string[];
  /** Canonical aliases: LLM-facing name → namespaced tool name */
  aliases?: Record<string, string>;
}

// ── Namespace prefixes ─────────────────────────────────────────────────

const NAMESPACE_PREFIXES: Record<ToolSourceType, string> = {
  vscode: 'ws',
  mcp: 'mcp',
  local: 'local',
};

/**
 * Build a namespaced tool name: "{prefix}:{sourceId}/{toolName}"
 */
function namespaceTool(sourceType: ToolSourceType, sourceId: string, toolName: string): string {
  const prefix = NAMESPACE_PREFIXES[sourceType];
  return `${prefix}:${sourceId}/${toolName}`;
}

// ── Glob matching ──────────────────────────────────────────────────────

/**
 * Simple glob match supporting '*' as a wildcard segment.
 * Examples: "mcp:filesystem/\*" matches "mcp:filesystem/readFile"
 *           "ws:\*\/readFile" matches "ws:myproject/readFile"
 */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Check if a namespaced tool name matches any pattern in a list.
 */
export function matchesAnyPattern(patterns: string[] | undefined, namespacedName: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some(p => globMatch(p, namespacedName));
}

// ── ToolRegistry ───────────────────────────────────────────────────────

export class ToolRegistry {
  /** All registered tools, keyed by namespacedName */
  private tools = new Map<string, RegisteredTool>();

  /** Aliases: canonical LLM-facing name → namespaced tool name */
  private aliases = new Map<string, string>();

  /**
   * Register tools from a source.
   *
   * @param sourceId - Identifier for the source (e.g., "myproject", "github", "myAgent")
   * @param sourceType - Source type: 'vscode', 'mcp', or 'local'
   * @param tools - Array of tool definitions to register
   *
   * @example
   * ```typescript
   * // Agent registering local tools with executors
   * registry.register('myAgent', 'local', [
   *   { name: 'search', description: 'Search docs', inputSchema: '...', executor: async (args) => ... },
   * ]);
   *
   * // Daemon registering VS Code tools (no executors — routed via backchannel)
   * registry.register('myproject', 'vscode', vsCodeTools);
   * ```
   */
  register(sourceId: string, sourceType: ToolSourceType, tools: ToolRegistrationInput[]): void {
    for (const t of tools) {
      const namespacedName = namespaceTool(sourceType, sourceId, t.name);
      this.tools.set(namespacedName, {
        namespacedName,
        source: `${NAMESPACE_PREFIXES[sourceType]}:${sourceId}`,
        sourceType,
        originalName: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        executor: t.executor,
      });
    }
  }

  /**
   * Remove all tools from a source.
   * Call when an MCP server disconnects or a VS Code workspace closes.
   */
  unregisterSource(source: string): void {
    for (const [key, tool] of this.tools) {
      if (tool.source === source) {
        this.tools.delete(key);
      }
    }
  }

  /**
   * Set canonical aliases: LLM-facing name → namespaced tool name.
   * Used for deduplication and ergonomic tool names.
   */
  setAliases(aliases: Record<string, string>): void {
    this.aliases.clear();
    for (const [alias, target] of Object.entries(aliases)) {
      this.aliases.set(alias, target);
    }
  }

  /**
   * List tools for the LLM as ToolDefinition[], applying policy filters.
   *
   * - Disabled tools are excluded
   * - Tool names sent to LLM are bare originalName (no namespace prefix)
   * - If two tools have the same originalName, aliases break the tie
   *
   * Compatible with CoreState.chat()'s ChatToolOptions.tools.
   */
  listForChat(policy?: ToolPolicyConfig): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    const seenNames = new Set<string>();

    for (const tool of this.tools.values()) {
      // Skip disabled tools
      if (matchesAnyPattern(policy?.disabled_tools, tool.namespacedName)) {
        continue;
      }

      // Determine the LLM-facing name: use alias if one points to this tool, otherwise originalName
      let llmName = tool.originalName;
      for (const [alias, target] of this.aliases) {
        if (target === tool.namespacedName) {
          llmName = alias;
          break;
        }
      }

      // Deduplicate: first registration wins unless alias overrides
      if (seenNames.has(llmName)) {
        continue;
      }
      seenNames.add(llmName);

      result.push({
        name: llmName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    return result;
  }

  /**
   * Build a ToolExecutor compatible with CoreState.chat().
   *
   * For 'local' tools: calls the registered inline executor directly.
   * For 'vscode'/'mcp' tools: delegates to the provided fallback.
   *
   * Library consumers typically don't need a fallback (all their tools are 'local').
   * The daemon provides a fallback that routes through VS Code backchannel / MCP pool.
   *
   * @param fallback - Optional callback for tools without inline executors
   *
   * @example
   * ```typescript
   * // Library consumer — all tools are local, no fallback needed:
   * const executor = registry.buildExecutor();
   *
   * // Daemon — provides fallback for VS Code and MCP tools:
   * const executor = registry.buildExecutor(async (tool, args) => {
   *   if (tool.sourceType === 'vscode') return invokeVSCodeTool(tool.originalName, args);
   *   if (tool.sourceType === 'mcp') return mcpPool.callTool(tool.source, tool.originalName, args);
   * });
   * ```
   */
  buildExecutor(fallback?: (tool: RegisteredTool, args: Record<string, any>) => Promise<any>): ToolExecutor {
    return async (toolName: string, args: Record<string, any>): Promise<any> => {
      const tool = this.resolve(toolName);
      if (!tool) {
        throw new Error(`Tool not found in registry: "${toolName}"`);
      }

      // Local tools with inline executors
      if (tool.executor) {
        return tool.executor(args);
      }

      // Delegate to fallback (daemon provides this for vscode/mcp tools)
      if (fallback) {
        return fallback(tool, args);
      }

      throw new Error(
        `Tool "${toolName}" (source: ${tool.source}) has no executor and no fallback was provided. ` +
        `Register local tools with an executor, or provide a fallback for remote tools.`
      );
    };
  }

  /**
   * Resolve a tool name to its RegisteredTool.
   *
   * Resolution order:
   * 1. Check aliases (bare name → namespaced name → lookup)
   * 2. Exact match on namespaced name
   * 3. First match on bare originalName
   */
  resolve(name: string): RegisteredTool | null {
    // 1. Check aliases
    const aliasTarget = this.aliases.get(name);
    if (aliasTarget) {
      const tool = this.tools.get(aliasTarget);
      if (tool) return tool;
    }

    // 2. Exact namespaced match
    const exact = this.tools.get(name);
    if (exact) return exact;

    // 3. Bare name match (first wins)
    for (const tool of this.tools.values()) {
      if (tool.originalName === name) {
        return tool;
      }
    }

    return null;
  }

  /** Get all registered tools (unfiltered) */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** Get all tools from a specific source */
  getBySource(source: string): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(t => t.source === source);
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }

  /** Remove all tools from the registry */
  clear(): void {
    this.tools.clear();
    this.aliases.clear();
  }
}
