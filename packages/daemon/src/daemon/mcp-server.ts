/**
 * AbbenayMcpServer — exposes aggregated tools as an MCP server.
 *
 * External MCP clients can connect to Abbenay and use all aggregated tools
 * (from VS Code workspaces, external MCP servers, and agent-registered tools)
 * through the standard MCP protocol.
 *
 * Uses @modelcontextprotocol/sdk with Streamable HTTP transport,
 * mounted on the daemon's Express web server at /mcp.
 *
 * Security (DR-033 / DR-034):
 * - /mcp is authenticated by the Express auth middleware (DR-030).
 * - New MCP clients must receive explicit connection consent before a session
 *   is established (initialize blocks until allow/deny).
 * - Non-initialize requests require an approved Mcp-Session-Id (no tools/call
 *   bypass without consent).
 * - Every tool invocation goes through createToolValidator / authorizeToolExecution
 *   (same path as chat).
 */

import * as crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { loadConfig } from '../core/config.js';
import {
  authorizeToolExecution,
  classifyToolPolicy,
  type OnToolApprovalNeeded,
} from '../core/tool-approval.js';
import type { RegisteredTool, ToolPolicyConfig, ToolRegistry } from '../core/tool-registry.js';
import type { ToolRouter } from './tool-router.js';
import { VERSION } from '../version.js';

/** Placeholder used when clientInfo.name is missing — never eligible for "remember". */
const UNKNOWN_CLIENT_NAME = 'unknown-client';

/**
 * Convert a JSON Schema object into a Zod raw shape for MCP registerTool().
 * The MCP SDK's deprecated tool() overload treats plain objects as annotations,
 * not inputSchema — which drops arguments (path becomes undefined).
 */
function jsonSchemaToZodRawShape(schema: Record<string, unknown>): ZodRawShape {
  const props = (schema.properties && typeof schema.properties === 'object')
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  );
  const shape: ZodRawShape = {};

  for (const [key, prop] of Object.entries(props)) {
    const type = prop?.type;
    let field: ZodTypeAny;
    switch (type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.any());
        break;
      case 'object':
        field = z.record(z.string(), z.any());
        break;
      default:
        field = z.any();
    }
    if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return shape;
}

export type ConnectionConsentDecision = 'allow' | 'deny';

/**
 * Called when an MCP client sends initialize and needs explicit user consent
 * before a session is created.
 */
export type OnConnectionConsentNeeded = (
  requestId: string,
  clientName: string,
  clientVersion: string,
) => Promise<ConnectionConsentDecision>;

export interface McpServerHooks {
  /** Load current tool_policy (called per invocation so config changes apply). */
  getPolicy?: () => ToolPolicyConfig | undefined;
  /** Block until the user approves/denies a tool call (web REST / dashboard). */
  onApprovalNeeded?: OnToolApprovalNeeded;
  /** Block until the user approves/denies a new MCP client connection. */
  onConnectionConsentNeeded?: OnConnectionConsentNeeded;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  clientName: string;
  clientVersion: string;
  connectedAt: number;
}

export interface McpSessionInfo {
  sessionId: string;
  clientName: string;
  clientVersion: string;
  connectedAt: number;
}

export class AbbenayMcpServer {
  private running = false;
  private hooks: McpServerHooks = {};
  /** Approved MCP Streamable HTTP sessions (sessionId → session). */
  private sessions = new Map<string, McpSession>();
  /** Client names approved with "Allow & Remember" for this daemon lifetime. */
  private rememberedClients = new Set<string>();

  constructor(
    private registry: ToolRegistry,
    private router: ToolRouter,
  ) {}

  /**
   * Configure policy loader and approval / connection-consent callbacks.
   */
  configure(hooks: McpServerHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /**
   * Remember a client name so future initialize skips the consent prompt.
   * Refuses empty names and the `unknown-client` placeholder — remember is a
   * DX shortcut keyed on client-reported name, not strong identity.
   */
  rememberClient(clientName: string): void {
    const name = clientName?.trim();
    if (!name || name === UNKNOWN_CLIENT_NAME) return;
    this.rememberedClients.add(name);
  }

  /** Forget a remembered client name (no-op if unknown). */
  forgetClient(clientName: string): void {
    const name = clientName?.trim();
    if (!name) return;
    this.rememberedClients.delete(name);
  }

  listRememberedClients(): string[] {
    return [...this.rememberedClients].sort();
  }

  listSessions(): McpSessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      clientName: s.clientName,
      clientVersion: s.clientVersion,
      connectedAt: s.connectedAt,
    }));
  }

  /** Revoke an approved session (client must re-consent on next initialize). */
  async revokeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch {
      /* ignore */
    }
    try {
      await session.server.close();
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * Mount /mcp routes on the Express app.
   *
   * Auth for /mcp is enforced by createWebApp()'s requireAuth middleware
   * (mounted before these routes).
   */
  async start(app: Express): Promise<void> {
    if (this.running) return;

    const handle = async (req: Request, res: Response, withBody: boolean): Promise<void> => {
      try {
        await this.handleHttpRequest(req, res, withBody);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[McpServer] Request error:', msg);
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP request failed' });
        }
      }
    };

    app.post('/mcp', (req, res) => { void handle(req, res, true); });
    app.get('/mcp', (req, res) => { void handle(req, res, false); });
    app.delete('/mcp', (req, res) => { void handle(req, res, false); });

    this.running = true;
    console.log('[McpServer] MCP server started at /mcp (auth + connection consent + tool_policy)');
  }

  /**
   * Notify clients that the tool list changed.
   */
  refreshTools(): void {
    if (!this.running) return;
    for (const session of this.sessions.values()) {
      try {
        session.server.sendToolListChanged();
      } catch {
        /* ignore per-session failures */
      }
    }
    console.log('[McpServer] Notified clients of tool list change');
  }

  /**
   * Stop the MCP server and tear down all sessions.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.revokeSession(id);
    }
    this.running = false;
    console.log('[McpServer] MCP server stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Authorize + execute a tool using the shared policy path.
   * Exposed for unit/integration tests (same logic as MCP tool handlers).
   */
  async authorizeAndExecute(
    tool: RegisteredTool,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const policy = this.resolvePolicy();
    const auth = await authorizeToolExecution(
      this.registry,
      policy,
      tool.originalName,
      args,
      this.hooks.onApprovalNeeded,
    );

    if (auth.decision !== 'allow') {
      return {
        content: [{ type: 'text', text: auth.message || 'Tool execution denied by policy' }],
        isError: true,
      };
    }

    try {
      const fallbackExecutor = this.router.buildFallbackExecutor();
      let result: unknown;
      if (tool.executor) {
        result = await tool.executor(args);
      } else {
        result = await fallbackExecutor(tool, args);
      }

      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: msg }],
        isError: true,
      };
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private resolvePolicy(): ToolPolicyConfig | undefined {
    if (this.hooks.getPolicy) {
      return this.hooks.getPolicy();
    }
    try {
      return loadConfig().tool_policy;
    } catch {
      return undefined;
    }
  }

  private sessionIdFromRequest(req: Request): string | undefined {
    const raw = req.headers['mcp-session-id'];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    return undefined;
  }

  private extractClientInfo(body: unknown): { name: string; version: string } {
    const params = (body as { params?: { clientInfo?: { name?: string; version?: string } } })?.params;
    const name = params?.clientInfo?.name?.trim() || UNKNOWN_CLIENT_NAME;
    const version = params?.clientInfo?.version?.trim() || '0.0.0';
    return { name, version };
  }

  /**
   * Connection consent (DR-034). Remembered clients skip the prompt.
   * Fail-closed when no consent handler is configured.
   */
  private async requireConnectionConsent(
    clientName: string,
    clientVersion: string,
  ): Promise<ConnectionConsentDecision> {
    if (this.rememberedClients.has(clientName)) {
      console.log(`[McpServer] Connection auto-allowed (remembered): ${clientName}`);
      return 'allow';
    }
    if (!this.hooks.onConnectionConsentNeeded) {
      console.warn('[McpServer] Connection denied: no onConnectionConsentNeeded handler');
      return 'deny';
    }
    const requestId = crypto.randomUUID();
    console.log(
      `[McpServer] Connection consent required: ${clientName}@${clientVersion} (requestId=${requestId})`,
    );
    return this.hooks.onConnectionConsentNeeded(requestId, clientName, clientVersion);
  }

  private async handleHttpRequest(
    req: Request,
    res: Response,
    withBody: boolean,
  ): Promise<void> {
    const sessionId = this.sessionIdFromRequest(req);

    // Existing approved session — reuse its transport
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (withBody) {
        await session.transport.handleRequest(req, res, req.body);
      } else {
        await session.transport.handleRequest(req, res);
      }
      return;
    }

    // New connection: only initialize may create a session, and only after consent
    if (req.method === 'POST' && withBody && isInitializeRequest(req.body)) {
      const client = this.extractClientInfo(req.body);
      const decision = await this.requireConnectionConsent(client.name, client.version);
      if (decision !== 'allow') {
        res.status(403).json({
          error: 'MCP client connection denied',
          clientName: client.name,
          clientVersion: client.version,
        });
        return;
      }

      const server = new McpServer({
        name: 'abbenay',
        version: VERSION,
      });
      this.registerToolsOn(server);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.sessions.set(id, {
            transport,
            server,
            clientName: client.name,
            clientVersion: client.version,
            connectedAt: Date.now(),
          });
          console.log(`[McpServer] Session established: ${id} (${client.name}@${client.version})`);
        },
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && this.sessions.has(id)) {
          this.sessions.delete(id);
          console.log(`[McpServer] Session closed: ${id}`);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session and not an initialize — refuse (closes tools/call bypass)
    res.status(403).json({
      error:
        'MCP client consent required. Send initialize, obtain user approval, ' +
        'then include the Mcp-Session-Id from the initialize response.',
    });
  }

  /**
   * Register tools from the registry onto an MCP server instance.
   * Disabled tools are omitted from the list (same as listForChat).
   * Execution still re-checks policy so a later disable cannot be bypassed.
   */
  private registerToolsOn(mcpServer: McpServer): void {
    const policy = this.resolvePolicy();
    const tools = this.registry.getAll().filter((tool) => {
      const tier = classifyToolPolicy(tool.namespacedName, policy);
      return tier !== 'disabled';
    });

    for (const tool of tools) {
      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(tool.inputSchema) as Record<string, unknown>;
      } catch {
        schema = { type: 'object', properties: {} };
      }

      const inputShape = jsonSchemaToZodRawShape(schema);
      // registerTool (not deprecated tool()) so JSON-derived schemas become
      // real inputSchema — otherwise args are dropped and the handler only
      // receives the MCP request "extra" object.
      mcpServer.registerTool(
        tool.originalName,
        {
          description: tool.description,
          inputSchema: inputShape,
        },
        async (args: Record<string, unknown>) => this.authorizeAndExecute(tool, args ?? {}),
      );
    }
  }
}
