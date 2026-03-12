/**
 * McpClientPool — manages connections to external MCP servers.
 *
 * Connects to MCP servers defined in config (stdio or HTTP/SSE transport),
 * discovers their tools, and registers them in the ToolRegistry.
 *
 * Uses @ai-sdk/mcp for the MCP client implementation.
 */

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolRegistry } from '../core/tool-registry.js';
import type { McpServerConfig } from '../core/config.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface McpServerStatus {
  id: string;
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  error?: string;
  connectedAt?: Date;
}

// ── McpClientPool ──────────────────────────────────────────────────────

export class McpClientPool {
  private clients = new Map<string, MCPClient>();
  private statuses = new Map<string, McpServerStatus>();

  constructor(private registry: ToolRegistry) {}

  /**
   * Connect to a single MCP server and register its tools.
   */
  async connect(serverId: string, config: McpServerConfig): Promise<void> {
    if (!config.enabled) {
      console.log(`[McpClientPool] Skipping disabled server: ${serverId}`);
      return;
    }

    if (this.isSelfConnection(config)) {
      console.warn(`[McpClientPool] Skipping self-connection: ${serverId}`);
      return;
    }

    // Disconnect existing connection if any
    if (this.clients.has(serverId)) {
      await this.disconnect(serverId);
    }

    const status: McpServerStatus = {
      id: serverId,
      config,
      connected: false,
      toolCount: 0,
    };
    this.statuses.set(serverId, status);

    try {
      const transport = this.buildTransport(config);
      const client = await createMCPClient({
        transport,
        name: `abbenay-${serverId}`,
        onUncaughtError: (error) => {
          console.error(`[McpClientPool] Uncaught error from ${serverId}:`, error);
          status.connected = false;
          status.error = String(error);
        },
      });

      this.clients.set(serverId, client);
      status.connected = true;
      status.connectedAt = new Date();

      // Discover and register tools
      await this.refreshTools(serverId, client);
      console.log(`[McpClientPool] Connected to ${serverId} (${status.toolCount} tools)`);

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      status.error = msg;
      console.error(`[McpClientPool] Failed to connect to ${serverId}: ${msg}`);
      throw error;
    }
  }

  /**
   * Disconnect from a single MCP server and unregister its tools.
   */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      try {
        await client.close();
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[McpClientPool] Error closing ${serverId}: ${msg}`);
      }
      this.clients.delete(serverId);
    }

    this.registry.unregisterSource(`mcp:${serverId}`);

    const status = this.statuses.get(serverId);
    if (status) {
      status.connected = false;
      status.toolCount = 0;
    }

    console.log(`[McpClientPool] Disconnected from ${serverId}`);
  }

  /**
   * Connect to all MCP servers from config.
   * Errors are logged but don't prevent other servers from connecting.
   */
  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const promises = Object.entries(configs).map(async ([id, config]) => {
      try {
        await this.connect(id, config);
      } catch {
        // Error already logged in connect()
      }
    });
    await Promise.allSettled(promises);
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.keys()).map(id => this.disconnect(id));
    await Promise.allSettled(promises);
  }

  /**
   * Reconnect a single server (useful for retry after error).
   */
  async reconnect(serverId: string): Promise<void> {
    const status = this.statuses.get(serverId);
    if (!status) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    await this.connect(serverId, status.config);
  }

  /**
   * Call a tool on a specific MCP server.
   * Used by ToolRouter as the fallback executor for 'mcp' source tools.
   *
   * @param source - Source identifier (e.g., "mcp:github")
   * @param toolName - Original tool name (not namespaced)
   * @param args - Tool arguments
   */
  async callTool(source: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    // Extract server ID from source: "mcp:github" → "github"
    const serverId = source.startsWith('mcp:') ? source.slice(4) : source;
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    // Get the AI SDK tool set and call the tool
    const toolSet = await client.tools();
    const tool = toolSet[toolName];
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found on MCP server "${serverId}"`);
    }

    const toolWithExecute = tool as unknown as { execute?: (args: Record<string, unknown>) => Promise<unknown> };
    if (typeof toolWithExecute.execute === 'function') {
      return toolWithExecute.execute(args);
    }

    throw new Error(`Tool "${toolName}" on MCP server "${serverId}" has no execute function`);
  }

  /**
   * Sync the pool with a new set of configs.
   * Connects new servers, disconnects removed servers, reconnects changed servers.
   */
  async syncWithConfig(configs: Record<string, McpServerConfig>): Promise<void> {
    const newIds = new Set(Object.keys(configs));
    const currentIds = new Set(this.clients.keys());

    // Disconnect removed servers
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        await this.disconnect(id);
        this.statuses.delete(id);
      }
    }

    // Connect or reconnect
    for (const [id, config] of Object.entries(configs)) {
      const existing = this.statuses.get(id);
      if (!existing || this.configChanged(existing.config, config)) {
        try {
          await this.connect(id, config);
        } catch {
          // Error logged in connect()
        }
      }
    }
  }

  /**
   * Get status of all MCP server connections.
   */
  getStatuses(): McpServerStatus[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Get status of a single MCP server.
   */
  getStatus(serverId: string): McpServerStatus | undefined {
    return this.statuses.get(serverId);
  }

  /**
   * Number of connected servers.
   */
  get connectedCount(): number {
    return this.clients.size;
  }

  // ── Internal ─────────────────────────────────────────────────────────

  /**
   * Build the appropriate transport for a config entry.
   */
  private buildTransport(config: McpServerConfig): StdioMCPTransport | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> } {
    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error('stdio transport requires a command');
      }
      return new StdioMCPTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      });
    }

    if (!config.url) {
      throw new Error(`${config.transport} transport requires a url`);
    }
    return {
      type: config.transport === 'sse' ? 'sse' as const : 'http' as const,
      url: config.url,
      headers: config.headers,
    };
  }

  /**
   * Discover tools from an MCP server and register them in the registry.
   */
  private async refreshTools(serverId: string, client: MCPClient): Promise<void> {
    const toolList = await client.listTools();
    const tools = (toolList.tools || []).map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: JSON.stringify(t.inputSchema || {}),
    }));

    this.registry.register(serverId, 'mcp', tools);

    const status = this.statuses.get(serverId);
    if (status) {
      status.toolCount = tools.length;
    }
  }

  /**
   * Guard against connecting to our own MCP server.
   */
  private isSelfConnection(config: McpServerConfig): boolean {
    if (config.transport === 'http' && config.url) {
      const url = config.url.toLowerCase();
      // Check for obvious self-referential URLs
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        // TODO: compare against our own MCP server port when Phase 4 is implemented
        return false;
      }
    }
    return false;
  }

  /**
   * Check if config has changed (shallow comparison of key fields).
   */
  private configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
    return (
      a.transport !== b.transport ||
      a.command !== b.command ||
      a.url !== b.url ||
      a.enabled !== b.enabled ||
      JSON.stringify(a.args) !== JSON.stringify(b.args) ||
      JSON.stringify(a.headers) !== JSON.stringify(b.headers) ||
      JSON.stringify(a.env) !== JSON.stringify(b.env)
    );
  }
}
