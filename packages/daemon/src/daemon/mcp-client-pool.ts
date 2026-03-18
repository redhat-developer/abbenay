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

export type McpServerSource = 'config' | 'dynamic';

export interface DynamicScope {
  sessionId?: string;
  clientId?: string;
}

export interface McpServerStatus {
  id: string;
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  error?: string;
  connectedAt?: Date;
  source: McpServerSource;
  scope?: DynamicScope;
}

// ── McpClientPool ──────────────────────────────────────────────────────

export class McpClientPool {
  private clients = new Map<string, MCPClient>();
  private statuses = new Map<string, McpServerStatus>();
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  /** Max dynamic MCP servers allowed (configurable via config.yaml) */
  private maxDynamicServers = 10;

  constructor(private registry: ToolRegistry) {}

  /**
   * Connect to a single config-based MCP server and register its tools.
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
      source: 'config',
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
   * Dynamically register an MCP server at runtime.
   * Returns the list of discovered tool names (namespaced).
   */
  async connectDynamic(
    serverId: string,
    config: McpServerConfig,
    scope?: DynamicScope,
    toolFilter?: string[],
  ): Promise<string[]> {
    if (this.hasConfigServer(serverId)) {
      throw new Error(`MCP server '${serverId}' is already defined in config`);
    }
    if (this.clients.has(serverId)) {
      throw new Error(`MCP server '${serverId}' is already registered`);
    }

    const dynamicCount = Array.from(this.statuses.values())
      .filter(s => s.source === 'dynamic').length;
    if (dynamicCount >= this.maxDynamicServers) {
      throw new Error(
        `Dynamic MCP server limit reached (${this.maxDynamicServers}). ` +
        `Unregister existing servers first.`,
      );
    }

    const status: McpServerStatus = {
      id: serverId,
      config: { ...config, enabled: true },
      connected: false,
      toolCount: 0,
      source: 'dynamic',
      scope,
    };
    this.statuses.set(serverId, status);

    try {
      const transport = this.buildTransport(config);
      const client = await createMCPClient({
        transport,
        name: `abbenay-dynamic-${serverId}`,
        onUncaughtError: (error) => {
          console.error(`[McpClientPool] Uncaught error from dynamic ${serverId}:`, error);
          status.connected = false;
          status.error = String(error);
        },
      });

      this.clients.set(serverId, client);
      status.connected = true;
      status.connectedAt = new Date();

      // Discover tools, optionally filtering
      await this.refreshTools(serverId, client, toolFilter);
      console.log(`[McpClientPool] Dynamic server '${serverId}' connected (${status.toolCount} tools, scope=${JSON.stringify(scope || 'global')})`);

      // Start health check timer if not running
      this.ensureHealthCheck();

      return this.registry.getBySource(`mcp:${serverId}`)
        .map(t => t.namespacedName);

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      status.error = msg;
      this.statuses.delete(serverId);
      console.error(`[McpClientPool] Failed to connect dynamic server '${serverId}': ${msg}`);
      throw error;
    }
  }

  /**
   * Check if a server_id belongs to a config-based (non-dynamic) server.
   */
  hasConfigServer(serverId: string): boolean {
    const status = this.statuses.get(serverId);
    return status !== undefined && status.source === 'config';
  }

  /**
   * Disconnect all dynamic MCP servers scoped to a session.
   */
  async disconnectByScope(sessionId: string): Promise<void> {
    const toRemove = Array.from(this.statuses.entries())
      .filter(([, s]) => s.source === 'dynamic' && s.scope?.sessionId === sessionId)
      .map(([id]) => id);

    for (const id of toRemove) {
      console.log(`[McpClientPool] Session '${sessionId}' ended — removing dynamic server '${id}'`);
      await this.disconnect(id);
      this.statuses.delete(id);
    }
  }

  /**
   * Disconnect all dynamic MCP servers registered by a client.
   */
  async disconnectByClient(clientId: string): Promise<void> {
    const toRemove = Array.from(this.statuses.entries())
      .filter(([, s]) => s.source === 'dynamic' && s.scope?.clientId === clientId)
      .map(([id]) => id);

    for (const id of toRemove) {
      console.log(`[McpClientPool] Client '${clientId}' disconnected — removing dynamic server '${id}'`);
      await this.disconnect(id);
      this.statuses.delete(id);
    }
  }

  /**
   * Set the max number of dynamic MCP servers (from config).
   */
  setMaxDynamicServers(max: number): void {
    this.maxDynamicServers = max;
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
   * Dynamic registrations are left untouched.
   */
  async syncWithConfig(configs: Record<string, McpServerConfig>): Promise<void> {
    const newIds = new Set(Object.keys(configs));
    const currentIds = new Set(this.clients.keys());

    // Disconnect removed config-based servers (skip dynamic)
    for (const id of currentIds) {
      const status = this.statuses.get(id);
      if (status?.source === 'dynamic') continue;
      if (!newIds.has(id)) {
        await this.disconnect(id);
        this.statuses.delete(id);
      }
    }

    // Connect or reconnect config-based servers
    for (const [id, config] of Object.entries(configs)) {
      const existing = this.statuses.get(id);
      if (existing?.source === 'dynamic') continue;
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
   * When toolFilter is provided, only matching tools are registered.
   */
  private async refreshTools(serverId: string, client: MCPClient, toolFilter?: string[]): Promise<void> {
    const toolList = await client.listTools();
    let tools = (toolList.tools || []).map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: JSON.stringify(t.inputSchema || {}),
    }));

    if (toolFilter && toolFilter.length > 0) {
      const filterSet = new Set(toolFilter);
      tools = tools.filter(t => filterSet.has(t.name));
    }

    const status = this.statuses.get(serverId);
    const scope = status?.source === 'dynamic' ? status.scope : undefined;
    this.registry.register(serverId, 'mcp', tools, scope?.sessionId);

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

  /**
   * Start periodic health check for dynamic MCP servers (every 60s).
   * Detects dead endpoints from crashed callers and removes them.
   */
  private ensureHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, 60_000);
  }

  /**
   * Probe all dynamic MCP servers and remove unreachable ones.
   * Uses listTools() as a lightweight connectivity check since MCPClient
   * does not expose a dedicated ping method.
   */
  async runHealthCheck(): Promise<void> {
    const dynamicEntries = Array.from(this.statuses.entries())
      .filter(([, s]) => s.source === 'dynamic' && s.connected);

    if (dynamicEntries.length === 0) {
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = undefined;
      }
      return;
    }

    for (const [serverId] of dynamicEntries) {
      const client = this.clients.get(serverId);
      if (!client) continue;

      try {
        await client.listTools();
      } catch {
        console.warn(`[McpClientPool] Dynamic server '${serverId}' unreachable, removing`);
        await this.disconnect(serverId);
        this.statuses.delete(serverId);
      }
    }
  }

  /**
   * Stop the health check timer (for shutdown).
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }
}
