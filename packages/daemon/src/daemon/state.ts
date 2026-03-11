/**
 * DaemonState — Full daemon state extending CoreState.
 *
 * Adds client registry, VS Code backchannel, and transport-specific
 * tool execution. This is the state used by the gRPC/web daemon.
 */

import { v4 as uuidv4 } from 'uuid';
import { CoreState, type ChatToolOptions } from '../core/state.js';
import type { ChatChunk, ChatParams, ToolExecutor } from '../core/engines.js';
import { KeychainSecretStore } from './secrets/keychain.js';
import { ToolRegistry } from '../core/tool-registry.js';
import { ToolRouter } from './tool-router.js';
import { McpClientPool } from './mcp-client-pool.js';
import { AbbenayMcpServer } from './mcp-server.js';

// Re-export core types needed by daemon consumers (gRPC service, web server)
export type { ChatToolOptions, ProviderInfo, ModelInfo } from '../core/state.js';
export type { ChatChunk, ChatParams, ToolDefinition, ToolExecutor, EngineInfo, DiscoveredModel } from '../core/engines.js';
export type { ConfigFile, ProviderConfig, ModelConfig } from '../core/config.js';
export type { SecretStore } from '../core/secrets.js';
export type { RegisteredTool, ToolPolicyConfig, ToolSourceType } from '../core/tool-registry.js';
export { ToolRegistry } from '../core/tool-registry.js';
export { ToolRouter } from './tool-router.js';
export { McpClientPool } from './mcp-client-pool.js';
export type { McpServerStatus } from './mcp-client-pool.js';
export { AbbenayMcpServer } from './mcp-server.js';

// ── Client types ───────────────────────────────────────────────────────

export enum ClientType {
  UNSPECIFIED = 'UNSPECIFIED',
  VSCODE = 'VSCODE',
  CLI = 'CLI',
  PYTHON = 'PYTHON',
  NODEJS = 'NODEJS',
  MCP = 'MCP',
}

export interface ConnectedClient {
  clientId: string;
  clientType: ClientType;
  connectedAt: Date;
  isSpawner: boolean;
  workspacePath?: string;
  workspacePaths: string[];
}

// ── VS Code connection ─────────────────────────────────────────────────

export interface VSCodeConnection {
  id: string;
  workspacePath?: string;
  workspaceFolders: string[];
  stream?: any; // grpc.ServerDuplexStream
  pendingRequests: Map<string, {
    resolve: (response: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

// ── DaemonState ────────────────────────────────────────────────────────

export class DaemonState extends CoreState {
  private clients = new Map<string, ConnectedClient>();
  private vscodeConnections = new Map<string, VSCodeConnection>();
  public readonly toolRouter: ToolRouter;
  public readonly mcpClientPool: McpClientPool;
  public readonly mcpServer: AbbenayMcpServer;

  constructor() {
    super({ secretStore: new KeychainSecretStore() });

    // Initialize tool registry, router, MCP client pool, and MCP server
    this.toolRegistry = new ToolRegistry();
    this.toolRouter = new ToolRouter();
    this.mcpClientPool = new McpClientPool(this.toolRegistry!);
    this.mcpServer = new AbbenayMcpServer(this.toolRegistry!, this.toolRouter);

    // Wire VS Code tool invoker into the router
    this.toolRouter.setVSCodeInvoker(
      async (toolName, args) => this.invokeVSCodeTool(toolName, args),
    );

    // Wire MCP tool caller into the router
    this.toolRouter.setMcpCaller(
      async (source, toolName, args) => this.mcpClientPool.callTool(source, toolName, args),
    );
  }

  /**
   * Initialize MCP connections from config.
   * Call this after the daemon starts to connect to configured MCP servers.
   */
  async initMcpConnections(): Promise<void> {
    const _config = this.loadProviderConfig();
    // loadProviderConfig only returns providers; load full config for mcp_servers
    const { loadConfig } = await import('../core/config.js');
    const fullConfig = loadConfig();
    if (fullConfig.mcp_servers && Object.keys(fullConfig.mcp_servers).length > 0) {
      console.log(`[DaemonState] Connecting to ${Object.keys(fullConfig.mcp_servers).length} MCP server(s)...`);
      await this.mcpClientPool.connectAll(fullConfig.mcp_servers);
      console.log(`[DaemonState] MCP pool: ${this.mcpClientPool.connectedCount} connected`);
    }
  }

  /**
   * Refresh MCP connections when config changes.
   */
  async refreshMcpConnections(): Promise<void> {
    const { loadConfig } = await import('../core/config.js');
    const fullConfig = loadConfig();
    await this.mcpClientPool.syncWithConfig(fullConfig.mcp_servers || {});
  }

  // ─── Chat override: inject tool router fallback as default executor ──

  async* chat(
    compositeModelId: string,
    messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: any[] }>,
    requestParams?: ChatParams,
    toolOptions?: ChatToolOptions,
  ): AsyncGenerator<ChatChunk> {
    const toolMode = toolOptions?.toolMode || 'auto';
    let toolExecutor: ToolExecutor | undefined;

    if (toolMode === 'auto') {
      if (toolOptions?.tools && toolOptions.tools.length > 0) {
        // Client-provided tools with VS Code backchannel executor (Phase 1 path)
        toolExecutor = async (toolName: string, args: Record<string, any>) => {
          console.log(`[DaemonState] Tool execution: ${toolName}`, JSON.stringify(args).substring(0, 200));
          try {
            const result = await this.invokeVSCodeTool(toolName, args);
            if (result.isError) {
              console.error(`[DaemonState] Tool error: ${toolName}:`, result.resultJson);
              return { error: result.resultJson };
            }
            return JSON.parse(result.resultJson);
          } catch (error: any) {
            console.error(`[DaemonState] Tool execution failed: ${toolName}:`, error.message);
            return { error: error.message };
          }
        };
      } else if (this.toolRegistry && this.toolRegistry.size > 0) {
        // Registry path: use router's fallback executor for vscode/mcp tools
        toolExecutor = this.toolRegistry.buildExecutor(this.toolRouter.buildFallbackExecutor());
      }
    }

    yield* super.chat(compositeModelId, messages, requestParams, toolOptions, toolExecutor);
  }

  // ─── Clients ─────────────────────────────────────────────────────────

  registerClient(
    clientType: ClientType,
    isSpawner: boolean = false,
    workspacePath?: string
  ): string {
    const clientId = uuidv4();

    this.clients.set(clientId, {
      clientId,
      clientType,
      connectedAt: new Date(),
      isSpawner,
      workspacePath,
      workspacePaths: workspacePath ? [workspacePath] : [],
    });

    return clientId;
  }

  unregisterClient(clientId: string): boolean {
    const removed = this.clients.delete(clientId);
    if (removed) {
      console.log(`[State] Client unregistered: ${clientId}`);
    }
    return removed;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  // ─── VS Code Backchannel ─────────────────────────────────────────────

  registerVSCodeConnection(stream?: any): string {
    const id = uuidv4();

    this.vscodeConnections.set(id, {
      id,
      workspaceFolders: [],
      stream,
      pendingRequests: new Map(),
    });

    console.log(`[State] VS Code connection registered: ${id}`);
    return id;
  }

  unregisterVSCodeConnection(id: string): boolean {
    const conn = this.vscodeConnections.get(id);
    if (conn) {
      // Clean up pending requests
      for (const [_reqId, pending] of conn.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('VS Code connection closed'));
      }
      conn.pendingRequests.clear();

      // Unregister tools from this workspace
      const workspaceName = conn.workspacePath
        ? conn.workspacePath.split('/').pop() || 'vscode'
        : 'vscode';
      this.toolRegistry?.unregisterSource(`ws:${workspaceName}`);
    }
    const removed = this.vscodeConnections.delete(id);
    if (removed) {
      console.log(`[State] VS Code connection unregistered: ${id}`);
    }
    return removed;
  }

  updateVSCodeWorkspace(id: string, workspacePath: string, workspaceFolders: string[]): void {
    const conn = this.vscodeConnections.get(id);
    if (conn) {
      conn.workspacePath = workspacePath;
      conn.workspaceFolders = workspaceFolders;
      console.log(`[State] VS Code workspace updated for ${id}: ${workspacePath} (${workspaceFolders.length} folders)`);
    }
  }

  handleVSCodeResponse(connId: string, response: any): void {
    const conn = this.vscodeConnections.get(connId);
    if (!conn) return;

    const requestId = response.request_id || response.requestId;
    if (!requestId) return;

    const pending = conn.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      conn.pendingRequests.delete(requestId);
      pending.resolve(response);
    }
  }

  async sendVSCodeRequest(connId: string, request: any, timeoutMs: number = 10000): Promise<any> {
    const conn = this.vscodeConnections.get(connId);
    if (!conn || !conn.stream) {
      throw new Error('VS Code connection not available');
    }

    const requestId = uuidv4();
    const fullRequest = { request_id: requestId, ...request };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error(`VS Code request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pendingRequests.set(requestId, { resolve, reject, timer });

      try {
        conn.stream.write(fullRequest);
      } catch (err) {
        conn.pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async requestWorkspace(connId: string): Promise<{ workspacePath: string; workspaceFolders: string[] }> {
    const response = await this.sendVSCodeRequest(connId, {
      get_workspace: {},
    });

    const ws = response.get_workspace || response.getWorkspace || {};
    const workspacePath = ws.workspace_path || ws.workspacePath || '';
    const workspaceFolders = ws.workspace_folders || ws.workspaceFolders || [];

    if (workspacePath || workspaceFolders.length > 0) {
      this.updateVSCodeWorkspace(connId, workspacePath, workspaceFolders);
    }

    return { workspacePath, workspaceFolders };
  }

  async invokeVSCodeTool(toolName: string, args: Record<string, unknown>): Promise<{ resultJson: string; isError: boolean }> {
    const connId = this.getFirstVSCodeConnection();
    if (!connId) throw new Error('No VS Code connection available');

    const response = await this.sendVSCodeRequest(connId, {
      invoke_tool: {
        tool_name: toolName,
        arguments_json: JSON.stringify(args),
      },
    });

    const result = response.invoke_tool || response.invokeTool || {};
    return {
      resultJson: result.result_json || result.resultJson || '{}',
      isError: result.is_error || result.isError || false,
    };
  }

  /**
   * Request the list of available tools from a VS Code connection
   * and register them in the ToolRegistry.
   */
  async requestVSCodeTools(connId: string): Promise<void> {
    const response = await this.sendVSCodeRequest(connId, {
      list_tools: {},
    });

    const result = response.list_tools || response.listTools || {};
    const tools = result.tools || [];

    if (tools.length === 0) {
      console.log(`[DaemonState] VS Code (${connId}) reported 0 tools`);
      return;
    }

    // Determine workspace name for namespacing
    const conn = this.vscodeConnections.get(connId);
    const workspaceName = conn?.workspacePath
      ? conn.workspacePath.split('/').pop() || 'vscode'
      : 'vscode';

    // Register tools in the registry
    const toolDefs = tools.map((t: any) => ({
      name: t.tool_name || t.toolName || t.name || '',
      description: t.description || '',
      inputSchema: t.input_schema || t.inputSchema || '{}',
    })).filter((t: any) => t.name);

    this.toolRegistry?.register(workspaceName, 'vscode', toolDefs);
    console.log(`[DaemonState] Registered ${toolDefs.length} VS Code tools from ws:${workspaceName}`);
  }

  /**
   * Handle an unsolicited RegisterTools notification from VS Code.
   * VS Code sends this when vscode.lm.onDidChangeTools fires.
   */
  handleRegisterToolsNotification(connId: string, notification: any): void {
    const tools = notification.tools || [];
    const conn = this.vscodeConnections.get(connId);
    const workspaceName = conn?.workspacePath
      ? conn.workspacePath.split('/').pop() || 'vscode'
      : 'vscode';

    // Unregister old tools from this source, then re-register
    this.toolRegistry?.unregisterSource(`ws:${workspaceName}`);

    const toolDefs = tools.map((t: any) => ({
      name: t.tool_name || t.toolName || t.name || '',
      description: t.description || '',
      inputSchema: t.input_schema || t.inputSchema || '{}',
    })).filter((t: any) => t.name);

    if (toolDefs.length > 0) {
      this.toolRegistry?.register(workspaceName, 'vscode', toolDefs);
    }
    console.log(`[DaemonState] VS Code tools updated: ${toolDefs.length} tools from ws:${workspaceName}`);

    // Notify MCP server clients that tool list changed
    this.mcpServer.refreshTools();
  }

  async listVSCodeModels(familyFilter?: string): Promise<any[]> {
    const connId = this.getFirstVSCodeConnection();
    if (!connId) return [];

    const response = await this.sendVSCodeRequest(connId, {
      list_models: {
        family_filter: familyFilter || '',
      },
    });

    const result = response.list_models || response.listModels || {};
    return result.models || [];
  }

  private getFirstVSCodeConnection(): string | null {
    for (const [id, conn] of this.vscodeConnections) {
      if (conn.stream) return id;
    }
    return null;
  }

  notifyModelsChanged(reason: string): void {
    for (const conn of this.vscodeConnections.values()) {
      if (conn.stream) {
        try {
          conn.stream.write({
            request_id: `notify-${Date.now()}`,
            models_changed: { reason },
          });
          console.log(`[State] Sent ModelsChanged notification to VS Code (reason: ${reason})`);
        } catch (err: any) {
          console.error(`[State] Failed to send ModelsChanged notification: ${err.message}`);
        }
      }
    }
  }

  getVSCodeWorkspaces(): string[] {
    const workspaces: string[] = [];

    for (const conn of this.vscodeConnections.values()) {
      if (conn.workspacePath && !workspaces.includes(conn.workspacePath)) {
        workspaces.push(conn.workspacePath);
      }
      for (const folder of conn.workspaceFolders) {
        if (!workspaces.includes(folder)) {
          workspaces.push(folder);
        }
      }
    }

    for (const client of this.clients.values()) {
      if (client.clientType === ClientType.VSCODE && client.workspacePath) {
        if (!workspaces.includes(client.workspacePath)) {
          workspaces.push(client.workspacePath);
        }
      }
    }

    return workspaces.sort();
  }

  getVSCodeConnectionIds(): string[] {
    return Array.from(this.vscodeConnections.keys());
  }

  hasVSCodeConnection(): boolean {
    return this.vscodeConnections.size > 0;
  }
}
