/**
 * AbbenayMcpServer — exposes aggregated tools as an MCP server.
 *
 * External MCP clients can connect to Abbenay and use all aggregated tools
 * (from VS Code workspaces, external MCP servers, and agent-registered tools)
 * through the standard MCP protocol.
 *
 * Uses @modelcontextprotocol/sdk with Streamable HTTP transport,
 * mounted on the daemon's Express web server at /mcp.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import type { ToolRegistry } from '../core/tool-registry.js';
import type { ToolRouter } from './tool-router.js';

export class AbbenayMcpServer {
  private mcpServer: McpServer;
  private transport?: StreamableHTTPServerTransport;
  private running = false;

  constructor(
    private registry: ToolRegistry,
    private router: ToolRouter,
  ) {
    this.mcpServer = new McpServer({
      name: 'abbenay',
      version: '0.1.0',
    });
  }

  /**
   * Register all tools from the registry with the MCP server
   * and start serving on the given Express app at /mcp.
   */
  async start(app: Express): Promise<void> {
    if (this.running) return;

    // Register tools from the registry
    this.registerTools();

    // Create stateless transport (no session management)
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await this.mcpServer.connect(this.transport);

    // Mount POST /mcp for MCP requests
    app.post('/mcp', async (req: Request, res: Response) => {
      try {
        await this.transport!.handleRequest(req, res, req.body);
      } catch (error: any) {
        console.error('[McpServer] Request error:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP request failed' });
        }
      }
    });

    // Mount GET /mcp for SSE stream (if client requests it)
    app.get('/mcp', async (req: Request, res: Response) => {
      try {
        await this.transport!.handleRequest(req, res);
      } catch (error: any) {
        console.error('[McpServer] SSE request error:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP SSE request failed' });
        }
      }
    });

    // Mount DELETE /mcp for session cleanup
    app.delete('/mcp', async (req: Request, res: Response) => {
      try {
        await this.transport!.handleRequest(req, res);
      } catch (error: any) {
        console.error('[McpServer] Delete request error:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP delete request failed' });
        }
      }
    });

    this.running = true;
    console.log('[McpServer] MCP server started at /mcp');
  }

  /**
   * Refresh registered tools (call when registry changes).
   */
  refreshTools(): void {
    if (!this.running) return;
    // The MCP SDK registers tools at server creation time.
    // For dynamic updates, notify clients that the tool list changed.
    this.mcpServer.sendToolListChanged();
    console.log('[McpServer] Notified clients of tool list change');
  }

  /**
   * Stop the MCP server.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    try {
      await this.mcpServer.close();
    } catch (error: any) {
      console.warn('[McpServer] Error closing:', error.message);
    }
    this.running = false;
    console.log('[McpServer] MCP server stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Internal ─────────────────────────────────────────────────────────

  /**
   * Register all tools from the registry as MCP tools.
   */
  private registerTools(): void {
    const tools = this.registry.getAll();
    const fallbackExecutor = this.router.buildFallbackExecutor();

    for (const tool of tools) {
      let schema: Record<string, any>;
      try {
        schema = JSON.parse(tool.inputSchema);
      } catch {
        schema = { type: 'object', properties: {} };
      }

      this.mcpServer.tool(
        tool.originalName,
        tool.description,
        schema,
        async (args: any) => {
          try {
            let result: any;
            if (tool.executor) {
              result = await tool.executor(args);
            } else {
              result = await fallbackExecutor(tool, args);
            }

            const text = typeof result === 'string' ? result : JSON.stringify(result);
            return {
              content: [{ type: 'text' as const, text }],
            };
          } catch (error: any) {
            return {
              content: [{ type: 'text' as const, text: error.message }],
              isError: true,
            };
          }
        },
      );
    }

    console.log(`[McpServer] Registered ${tools.length} tools`);
  }
}
