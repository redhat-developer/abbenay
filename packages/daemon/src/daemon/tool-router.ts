/**
 * ToolRouter — daemon-specific tool execution routing.
 *
 * Provides the fallback executor for ToolRegistry.buildExecutor() in the daemon context.
 * Knows how to reach VS Code backchannel and MCP client pool — things that
 * @abbenay/core doesn't (and shouldn't) know about.
 */

import type { RegisteredTool } from '../core/tool-registry.js';

/**
 * Callback type for invoking a VS Code tool via the gRPC backchannel.
 */
export type VSCodeToolInvoker = (
  toolName: string,
  args: Record<string, any>,
) => Promise<{ resultJson: string; isError: boolean }>;

/**
 * Callback type for calling a tool on an external MCP server.
 */
export type McpToolCaller = (
  source: string,
  toolName: string,
  args: Record<string, any>,
) => Promise<any>;

export class ToolRouter {
  private vsCodeInvoker?: VSCodeToolInvoker;
  private mcpCaller?: McpToolCaller;

  /**
   * Set the VS Code tool invoker (wired when DaemonState has a VS Code connection).
   */
  setVSCodeInvoker(invoker: VSCodeToolInvoker): void {
    this.vsCodeInvoker = invoker;
  }

  /**
   * Set the MCP tool caller (wired when McpClientPool is initialized).
   */
  setMcpCaller(caller: McpToolCaller): void {
    this.mcpCaller = caller;
  }

  /**
   * Build a fallback executor for ToolRegistry.buildExecutor().
   *
   * This handles 'vscode' and 'mcp' source tools by routing to the
   * appropriate transport backend.
   */
  buildFallbackExecutor(): (tool: RegisteredTool, args: Record<string, any>) => Promise<any> {
    return async (tool: RegisteredTool, args: Record<string, any>): Promise<any> => {
      switch (tool.sourceType) {
        case 'vscode': {
          if (!this.vsCodeInvoker) {
            throw new Error('No VS Code connection available for tool execution');
          }
          const result = await this.vsCodeInvoker(tool.originalName, args);
          console.log(`[ToolRouter] VS Code tool "${tool.originalName}" result: isError=${result.isError}, length=${result.resultJson?.length || 0}, preview=${result.resultJson?.substring(0, 200)}`);
          if (result.isError) {
            return { error: result.resultJson };
          }
          try {
            return JSON.parse(result.resultJson);
          } catch {
            return result.resultJson;
          }
        }

        case 'mcp': {
          if (!this.mcpCaller) {
            throw new Error('No MCP client pool available for tool execution');
          }
          return this.mcpCaller(tool.source, tool.originalName, args);
        }

        case 'local':
          // Local tools should have inline executors — this shouldn't be reached
          throw new Error(
            `Local tool "${tool.originalName}" has no inline executor. ` +
            `Register local tools with an executor function.`
          );

        default:
          throw new Error(`Unknown tool source type: ${tool.sourceType}`);
      }
    };
  }
}
