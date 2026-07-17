/**
 * Web dashboard server (embedded in daemon)
 * 
 * Runs Express in the daemon process with direct DaemonState access.
 * No gRPC client layer — the web server calls state methods directly.
 * 
 * Lifecycle:
 * - Started via `abbenay web` or gRPC StartWebServer
 * - Stopped via Ctrl+C, `abbenay web` exit, or gRPC StopWebServer
 */

import express, { type Express, type Request, type Response } from 'express';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDefaultSocketPath } from '../transport.js';
import { loadConfig, saveConfig, loadWorkspaceConfig, saveWorkspaceConfig, getUserConfigPath, getWorkspaceConfigPath, isValidVirtualName, type ConfigFile, type ProviderConfig } from '../../core/config.js';
import { listAllPolicies, loadCustomPolicies, saveCustomPolicies, BUILTIN_POLICY_NAMES, type PolicyConfig } from '../../core/policies.js';
import { maybeSummarize, generateSessionSummary } from '../../core/session-summarizer.js';
import type { DaemonState } from '../state.js';
import type { ChatToolOptions } from '../../core/state.js';
import { getEngines, getProviderTemplates } from '../../core/engines.js';
import { DEFAULT_WEB_PORT, DEFAULT_HTTP_HOST } from '../../core/constants.js';
import { registerOpenAIRoutes } from './openai-compat.js';
import {
  createAuthMiddleware,
  createCorsMiddleware,
  resolveHttpSecurity,
  setAuthCookies,
  getCookie,
  cookieSecureFromRequest,
  timingSafeEqualString,
  API_TOKEN_COOKIE,
  CSRF_COOKIE,
  isLocalhostBind,
  assertHttpAuthBindAllowed,
  type WebSecurityOptions,
  type ResolvedHttpSecurity,
  type RequestWithOwner,
} from './http-security.js';
import { LOCAL_SESSION_OWNER } from '../../core/session-store.js';

export type { WebSecurityOptions, ResolvedHttpSecurity } from './http-security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the static files directory. Checks:
 *  1) ABBENAY_STATIC_DIR env var
 *  2) Next to parent dir: __dirname/../static/  (esbuild bundle, __dirname is web/)
 *  3) __dirname/static/ (flat bundle)
 *  4) Monorepo layout: __dirname/../../static/  (development from dist/web/)
 */
function resolveStaticPath(): string {
  const candidates = [
    process.env.ABBENAY_STATIC_DIR,
    path.resolve(__dirname, '../static'),
    path.resolve(__dirname, 'static'),
    path.resolve(__dirname, '../../../static'),
  ].filter(Boolean) as string[];
  
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  
  // Return last candidate even if not found — error will surface at serve time
  return candidates[candidates.length - 1];
}

const STATIC_PATH = resolveStaticPath();

/**
 * Create the Express application with direct DaemonState access.
 *
 * Used both for production (embedded in daemon) and testing.
 * All /api/*, /v1/*, and /mcp routes require Bearer (or cookie) auth unless
 * ABBENAY_HTTP_AUTH disables authentication for local development.
 */
export function createWebApp(state: DaemonState, options?: WebSecurityOptions): Express {
  const app = express();
  const port = options?.port ?? DEFAULT_WEB_PORT;
  const security = resolveHttpSecurity(port, options?.host, options);
  app.locals.httpSecurity = security;

  // Parse JSON / form bodies (form used by POST /login)
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS — explicit allowlist only (never *)
  app.use(createCorsMiddleware(security.corsOrigins));

  // Prevent browser caching of HTML so dashboard always serves fresh content
  app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });

  const isLoopbackClient = (req: Request): boolean => {
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  };

  const cookieOpts = (req: Request) => ({ secure: cookieSecureFromRequest(req) });

  const hasValidAuthCookie = (req: Request): boolean => {
    const cookieToken = getCookie(req, API_TOKEN_COOKIE);
    return cookieToken !== null && timingSafeEqualString(cookieToken, security.apiToken);
  };

  const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Abbenay login</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}
  label{display:block;margin-bottom:.5rem;font-weight:600}
  input[type=password]{width:100%;padding:.5rem;box-sizing:border-box}
  button{margin-top:1rem;padding:.5rem 1rem}
  .err{color:#b00020;margin-bottom:1rem}
</style></head><body>
<h1>Abbenay</h1>
<p>Enter the HTTP API token to open the dashboard. Prefer this form (or
<code>POST /login</code>) over putting the token in the URL.</p>
{{ERROR}}
<form method="post" action="/login">
  <label for="token">API token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
</body></html>`;

  /**
   * Serve dashboard HTML. Establishes SameSite auth cookies when auth is
   * enabled and:
   * - POST /login (preferred) or legacy ?token=<apiToken> succeeded, or
   * - the client is loopback (safe with default 127.0.0.1 bind)
   *
   * The API token is never embedded in HTML for remote clients; the dashboard
   * authenticates via HttpOnly cookie + CSRF header (and API clients use Bearer).
   */
  const serveDashboardHtml = (req: Request, res: Response): void => {
    const indexPath = path.join(STATIC_PATH, 'index.html');
    if (!fs.existsSync(indexPath)) {
      res.status(404).send('Web dashboard not found. Static files not at: ' + STATIC_PATH);
      return;
    }

    if (!security.authEnabled) {
      res.type('html').send(fs.readFileSync(indexPath, 'utf-8'));
      return;
    }

    // Legacy query login (kept for compat). Prefer POST /login — query tokens
    // can leak via history, Referer, and access logs.
    const q = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (q !== undefined) {
      if (!timingSafeEqualString(q, security.apiToken)) {
        res.status(401).send('Invalid token');
        return;
      }
      setAuthCookies(res, security.apiToken, cookieOpts(req));
      res.redirect(302, '/');
      return;
    }

    const hasAuthCookie = hasValidAuthCookie(req);
    const mayEstablishSession = hasAuthCookie || isLoopbackClient(req) || isLocalhostBind(security.host);

    let csrf = getCookie(req, CSRF_COOKIE);
    if (mayEstablishSession && (!hasAuthCookie || !csrf)) {
      csrf = setAuthCookies(res, security.apiToken, cookieOpts(req));
    }

    let html = fs.readFileSync(indexPath, 'utf-8');
    // Inject CSRF for dashboard mutating requests; never inject the API token.
    const inject = `<script>window.__ABBENAY_CSRF__=${JSON.stringify(csrf || '')};</script>`;
    html = html.includes('</head>')
      ? html.replace('</head>', `${inject}</head>`)
      : `${inject}${html}`;
    res.type('html').send(html);
  };

  const extractLoginToken = (req: Request): string => {
    const body = req.body as { token?: unknown; api_token?: unknown } | undefined;
    if (typeof body?.token === 'string') return body.token;
    if (typeof body?.api_token === 'string') return body.api_token;
    return '';
  };

  app.get('/login', (req, res) => {
    // Always offer the form when unauthenticated — loopback clients can also
    // open `/` for auto cookie establish, but /login must not put the token
    // in the URL for remote (or any) users.
    if (!security.authEnabled || hasValidAuthCookie(req)) {
      res.redirect(302, '/');
      return;
    }
    res.type('html').send(LOGIN_PAGE.replace('{{ERROR}}', ''));
  });

  app.post('/login', (req, res) => {
    if (!security.authEnabled) {
      res.redirect(302, '/');
      return;
    }
    const token = extractLoginToken(req);
    if (!timingSafeEqualString(token, security.apiToken)) {
      const wantsJson = req.is('application/json') || (req.headers.accept || '').includes('application/json');
      if (wantsJson) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
      res.status(401).type('html').send(
        LOGIN_PAGE.replace('{{ERROR}}', '<p class="err">Invalid token</p>'),
      );
      return;
    }
    setAuthCookies(res, security.apiToken, cookieOpts(req));
    const wantsJson = req.is('application/json') || (req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      res.status(204).end();
      return;
    }
    res.redirect(302, '/');
  });

  app.get('/', serveDashboardHtml);
  app.get('/index.html', serveDashboardHtml);

  // Serve other static files (CSS/JS assets next to index.html)
  if (fs.existsSync(STATIC_PATH)) {
    app.use(express.static(STATIC_PATH, { index: false }));
  }

  // Auth gate for all API / OpenAI-compat / MCP routes (no-op when auth disabled)
  const requireAuth = createAuthMiddleware(
    security.apiToken,
    security.corsOrigins,
    security.authEnabled,
  );
  app.use('/api', requireAuth);
  app.use('/v1', requireAuth);
  app.use('/mcp', requireAuth);

  // ── MCP connection consent + tool approval (DR-033 / DR-034) ───────────
  // Connection: initialize blocks until POST /api/mcp/connections resolves.
  // Tools: authorizeAndExecute blocks until POST /api/mcp/approvals resolves.
  // Abandoned pending entries auto-deny after mcpPendingTtlMs (default 5m).
  const DEFAULT_MCP_PENDING_TTL_MS = 5 * 60 * 1000;
  const mcpPendingTtlMs = options?.mcpPendingTtlMs != null && options.mcpPendingTtlMs > 0
    ? options.mcpPendingTtlMs
    : DEFAULT_MCP_PENDING_TTL_MS;

  const pendingMcpApprovals = new Map<string, {
    resolve: (decision: 'allow' | 'deny' | 'abort') => void;
    toolName: string;
    namespacedName?: string;
    args: unknown;
    createdAt: number;
  }>();

  const pendingMcpConnections = new Map<string, {
    resolve: (decision: 'allow' | 'deny') => void;
    clientName: string;
    clientVersion: string;
    createdAt: number;
  }>();

  if (typeof state.mcpServer?.configure === 'function') {
    state.mcpServer.configure({
      getPolicy: () => {
        try {
          return loadConfig().tool_policy;
        } catch {
          return undefined;
        }
      },
      onApprovalNeeded: async (requestId, toolName, args, namespacedName) => {
        console.log(
          `[Web] MCP tool approval required: ${namespacedName || toolName} (requestId=${requestId})`,
        );
        return new Promise<'allow' | 'deny' | 'abort'>((resolve) => {
          const timer = setTimeout(() => {
            if (!pendingMcpApprovals.has(requestId)) return;
            pendingMcpApprovals.delete(requestId);
            console.log(
              `[Web] MCP tool approval expired → deny: ${namespacedName || toolName} (requestId=${requestId})`,
            );
            resolve('deny');
          }, mcpPendingTtlMs);
          pendingMcpApprovals.set(requestId, {
            resolve: (decision) => {
              clearTimeout(timer);
              resolve(decision);
            },
            toolName,
            namespacedName,
            args,
            createdAt: Date.now(),
          });
        });
      },
      onConnectionConsentNeeded: async (requestId, clientName, clientVersion) => {
        console.log(
          `[Web] MCP connection consent required: ${clientName}@${clientVersion} (requestId=${requestId})`,
        );
        return new Promise<'allow' | 'deny'>((resolve) => {
          const timer = setTimeout(() => {
            if (!pendingMcpConnections.has(requestId)) return;
            pendingMcpConnections.delete(requestId);
            console.log(
              `[Web] MCP connection consent expired → deny: ${clientName}@${clientVersion} (requestId=${requestId})`,
            );
            resolve('deny');
          }, mcpPendingTtlMs);
          pendingMcpConnections.set(requestId, {
            resolve: (decision) => {
              clearTimeout(timer);
              resolve(decision);
            },
            clientName,
            clientVersion,
            createdAt: Date.now(),
          });
        });
      },
    });
  }

  /**
   * GET /api/mcp/connections — pending connection consents + active sessions
   */
  app.get('/api/mcp/connections', (_req, res) => {
    const pending = [...pendingMcpConnections.entries()].map(([requestId, p]) => ({
      requestId,
      clientName: p.clientName,
      clientVersion: p.clientVersion,
      createdAt: p.createdAt,
    }));
    const sessions = typeof state.mcpServer?.listSessions === 'function'
      ? state.mcpServer.listSessions()
      : [];
    const remembered = typeof state.mcpServer?.listRememberedClients === 'function'
      ? state.mcpServer.listRememberedClients()
      : [];
    res.json({ pending, sessions, remembered });
  });

  /**
   * POST /api/mcp/connections/:requestId — allow / deny a pending MCP client connection
   * Body: { decision: 'allow' | 'deny', remember?: boolean }
   */
  app.post('/api/mcp/connections/:requestId', (req, res) => {
    const { requestId } = req.params;
    const { decision, remember } = req.body as { decision?: string; remember?: boolean };
    if (!decision || !['allow', 'deny'].includes(decision)) {
      res.status(400).json({ error: 'decision must be allow or deny' });
      return;
    }
    const pending = pendingMcpConnections.get(requestId);
    if (!pending) {
      res.status(404).json({ error: `No pending MCP connection with requestId "${requestId}"` });
      return;
    }
    console.log(
      `[Web] MCP connection: ${pending.clientName}@${pending.clientVersion} → ${decision}` +
        (remember && decision === 'allow' ? ' (remember)' : '') +
        ` (requestId=${requestId})`,
    );
    if (decision === 'allow' && remember && typeof state.mcpServer?.rememberClient === 'function') {
      state.mcpServer.rememberClient(pending.clientName);
    }
    pending.resolve(decision as 'allow' | 'deny');
    pendingMcpConnections.delete(requestId);
    res.json({ success: true });
  });

  /**
   * DELETE /api/mcp/connections/sessions/:sessionId — revoke an approved session
   */
  app.delete('/api/mcp/connections/sessions/:sessionId', async (req, res) => {
    try {
      if (typeof state.mcpServer?.revokeSession !== 'function') {
        res.status(404).json({ error: 'MCP server does not support session revoke' });
        return;
      }
      const ok = await state.mcpServer.revokeSession(req.params.sessionId);
      if (!ok) {
        res.status(404).json({ error: `No MCP session "${req.params.sessionId}"` });
        return;
      }
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /api/mcp/connections/remembered/:clientName — forget a remembered client
   */
  app.delete('/api/mcp/connections/remembered/:clientName', (req, res) => {
    const clientName = decodeURIComponent(req.params.clientName || '').trim();
    if (!clientName) {
      res.status(400).json({ error: 'clientName is required' });
      return;
    }
    if (typeof state.mcpServer?.forgetClient !== 'function') {
      res.status(404).json({ error: 'MCP server does not support forgetClient' });
      return;
    }
    const before = typeof state.mcpServer.listRememberedClients === 'function'
      ? state.mcpServer.listRememberedClients()
      : [];
    if (!before.includes(clientName)) {
      res.status(404).json({ error: `No remembered MCP client "${clientName}"` });
      return;
    }
    state.mcpServer.forgetClient(clientName);
    console.log(`[Web] MCP remembered client forgotten: ${clientName}`);
    res.json({ success: true, forgotten: clientName });
  });

  /**
   * GET /api/mcp/approvals — list pending MCP tool approval requests
   */
  app.get('/api/mcp/approvals', (_req, res) => {
    const pending = [...pendingMcpApprovals.entries()].map(([requestId, p]) => ({
      requestId,
      toolName: p.toolName,
      namespacedName: p.namespacedName,
      args: p.args,
      createdAt: p.createdAt,
    }));
    res.json({ pending });
  });

  /**
   * POST /api/mcp/approvals/:requestId — approve / deny / abort a pending MCP tool call
   * Body: { decision: 'allow' | 'deny' | 'abort' }
   */
  app.post('/api/mcp/approvals/:requestId', (req, res) => {
    const { requestId } = req.params;
    const { decision } = req.body as { decision?: string };
    if (!decision || !['allow', 'deny', 'abort'].includes(decision)) {
      res.status(400).json({ error: 'decision must be allow, deny, or abort' });
      return;
    }
    const pending = pendingMcpApprovals.get(requestId);
    if (!pending) {
      res.status(404).json({ error: `No pending MCP approval with requestId "${requestId}"` });
      return;
    }
    console.log(`[Web] MCP tool approval: ${pending.namespacedName || pending.toolName} → ${decision} (requestId=${requestId})`);
    pending.resolve(decision as 'allow' | 'deny' | 'abort');
    pendingMcpApprovals.delete(requestId);
    res.json({ success: true });
  });

  // ─── API Routes ────────────────────────────────────────────────────────

  /**
   * GET /api/health - Health check (requires auth; pass Bearer for probes)
   */
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      daemon: 'connected',
      version: state.version,
      healthy: true,
      socketPath: getDefaultSocketPath(),
    });
  });
  
  /**
   * GET /api/providers - List all providers with configuration status
   */
  app.get('/api/providers', async (req, res) => {
    try {
      const providers = await state.listProviders();
      res.json({
        providers: providers.map((p) => ({
          id: p.id,
          engine: p.engine,
          configured: p.configured,
          healthy: p.healthy,
          requiresKey: p.requiresKey,
          defaultBaseUrl: p.defaultBaseUrl,
          baseUrl: p.baseUrl,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/providers error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/engines - List available engine types (for Add Provider wizard)
   * Returns the fixed set of API implementations from the Vercel AI SDK.
   */
  app.get('/api/engines', (req, res) => {
    const engines = getEngines().map(e => ({
      id: e.id,
      requiresKey: e.requiresKey,
      defaultBaseUrl: e.defaultBaseUrl,
      defaultEnvVar: e.defaultEnvVar,
    }));
    res.json({ engines });
  });
  
  /**
   * GET /api/templates - Predefined provider templates for the wizard
   */
  app.get('/api/templates', (req, res) => {
    res.json({ templates: getProviderTemplates() });
  });
  
  /**
   * GET /api/discover-models/:providerId - Discover all models a provider offers
   * Ignores config — for browsing/selection UI. Does NOT trigger notifications.
   */
  /**
   * GET /api/discover-models/:engineId - Discover all models an engine offers
   * Operates on the actual layer (engine, not virtual provider).
   * Query params: ?apiKey=xxx&baseUrl=xxx (optional, for authenticated discovery)
   */
  app.get('/api/discover-models/:engineId', async (req, res) => {
    try {
      let apiKey = req.query.apiKey as string | undefined;
      let baseUrl = req.query.baseUrl as string | undefined;
      const providerId = req.query.providerId as string | undefined;
      
      // If providerId is given (edit mode), resolve API key and base URL from config
      if (providerId && !apiKey) {
        const resolved = await state.resolveProviderCredentials(providerId);
        if (resolved.apiKey) apiKey = resolved.apiKey;
        if (resolved.baseUrl && !baseUrl) baseUrl = resolved.baseUrl;
      }
      
      const models = await state.discoverModels(req.params.engineId, apiKey, baseUrl);
      res.json({
        models: models.map((m) => ({
          id: m.id,
          engine: m.engine,
          contextWindow: m.contextWindow,
          capabilities: {
            tools: m.capabilities?.supportsTools || false,
            vision: m.capabilities?.supportsVision || false,
          },
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/discover-models error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/models - List models from configured providers
   * Optional query: ?workspace=/path/to/workspace (uses workspace config overlay)
   */
  app.get('/api/models', async (req, res) => {
    try {
      const workspace = req.query.workspace as string | undefined;
      const workspacePaths = workspace ? [workspace] : [];
      const models = await state.listModels(workspacePaths);
      res.json({
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          engineModelId: m.engineModelId,
          provider: m.provider,
          engine: m.engine,
          contextWindow: m.contextWindow,
          capabilities: {
            tools: m.capabilities?.supportsTools || false,
            vision: m.capabilities?.supportsVision || false,
          },
          params: m.params,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/models error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/config?location=user|<workspacePath> - Get configuration
   * Returns { config: ConfigFile, path: string }
   */
  app.get('/api/config', (req, res) => {
    try {
      const location = (req.query.location as string) || 'user';
      let config: ConfigFile;
      let configPath: string;
      
      if (location === 'user') {
        config = loadConfig() || { providers: {} };
        configPath = getUserConfigPath();
      } else {
        // location is a workspace path
        config = loadWorkspaceConfig(location) || { providers: {} };
        configPath = getWorkspaceConfigPath(location);
      }
      
      res.json({ config, path: configPath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/config GET error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * POST /api/config - Save configuration
   * Accepts { location: 'user' | workspacePath, config: ConfigFile }
   */
  app.post('/api/config', (req, res) => {
    try {
      const { location, config } = req.body;
      const loc = location || 'user';
      let savedPath: string;
      
      if (loc === 'user') {
        saveConfig(config);
        savedPath = getUserConfigPath();
      } else {
        saveWorkspaceConfig(loc, config);
        savedPath = getWorkspaceConfigPath(loc);
      }
      
      res.json({ success: true, path: savedPath });
      state.notifyModelsChanged('config_changed');
      state.refreshMcpConnections().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Web] MCP refresh after config change failed:', msg);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/config POST error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/workspaces - Get connected VS Code workspaces
   * 
   * First checks the cache. If empty but VS Code connections exist,
   * queries them via backchannel for real-time workspace info.
   */
  app.get('/api/workspaces', async (req, res) => {
    try {
      let workspaces = state.getVSCodeWorkspaces();
      
      // If cache is empty, try querying connected VS Code instances
      if (workspaces.length === 0) {
        const connIds = state.getVSCodeConnectionIds();
        for (const connId of connIds) {
          try {
            const _ws = await state.requestWorkspace(connId);
            // requestWorkspace updates the cache internally
          } catch {
            // VS Code might not respond in time, that's OK
          }
        }
        workspaces = state.getVSCodeWorkspaces();
      }
      
      // Also include workspace paths from registered clients as fallback
      if (workspaces.length === 0) {
        const clients = state.getClients();
        for (const c of clients) {
          if (c.workspacePath && !workspaces.includes(c.workspacePath)) {
            workspaces.push(c.workspacePath);
          }
        }
      }
      
      res.json({ workspaces });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/workspaces error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/status - Get daemon status
   */
  app.get('/api/status', (req, res) => {
    try {
      const clients = state.getClients();
      res.json({
        version: state.version,
        startedAt: state.startedAt.toISOString(),
        connectedClients: state.clientCount,
        activeSessions: 0,
        clients: clients.map(c => ({
          clientId: c.clientId,
          clientType: c.clientType,
          connectedAt: c.connectedAt.toISOString(),
          isSpawner: c.isSpawner,
          workspacePath: c.workspacePath || '',
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/status error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/secrets - List secret keys with availability status
   */
  app.get('/api/secrets', async (req, res) => {
    try {
      const engines = getEngines();
      const secrets = await Promise.all(
        engines.filter(e => e.requiresKey).map(async (e) => {
          const key = e.defaultEnvVar || `${e.id.toUpperCase()}_API_KEY`;
          const hasValue = await state.secretStore.has(key);
          return { key, engine: e.id, hasValue };
        })
      );
      res.json({ secrets });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/secrets error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * POST /api/secrets/:key - Set a specific secret (API key)
   * Body: { value: string }
   */
  app.post('/api/secrets/:key', async (req, res) => {
    try {
      const key = req.params.key;
      const { value } = req.body;
      if (!value) {
        res.status(400).json({ error: 'value required' });
        return;
      }
      await state.secretStore.set(key, value);
      res.json({ success: true });
      state.notifyModelsChanged('secret_updated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/secrets POST error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * POST /api/secrets - Set a secret (API key) — legacy route
   * Body: { key: string, value: string }
   */
  app.post('/api/secrets', async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || !value) {
        res.status(400).json({ error: 'key and value required' });
        return;
      }
      await state.secretStore.set(key, value);
      res.json({ success: true });
      state.notifyModelsChanged('secret_updated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/secrets POST error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * DELETE /api/secrets/:key - Delete a secret
   */
  app.delete('/api/secrets/:key', async (req, res) => {
    try {
      await state.secretStore.delete(req.params.key);
      res.json({ success: true });
      state.notifyModelsChanged('secret_deleted');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/secrets DELETE error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * GET /api/key-status - Check if a specific key is available
   * Query: source=keychain|env, name=KEY_NAME
   */
  app.get('/api/key-status', async (req, res) => {
    try {
      const source = req.query.source as string;
      const name = req.query.name as string;
      
      if (!source || !name) {
        res.status(400).json({ error: 'source and name query params required' });
        return;
      }
      
      let exists = false;
      if (source === 'keychain') {
        exists = await state.secretStore.has(name);
      } else if (source === 'env') {
        exists = !!process.env[name];
      }
      
      res.json({ exists });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/key-status error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  // ── Tool approval gate for pending chat requests ────────────────────────

  const pendingApprovals = new Map<string, {
    resolve: (decision: 'allow' | 'deny' | 'abort') => void;
    toolName: string;
    args: unknown;
    chatId: string;
  }>();

  /**
   * POST /api/chat/:chatId/approve - Approve or deny a pending tool execution
   * Body: { requestId: string, decision: 'allow' | 'deny' | 'abort' }
   */
  app.post('/api/chat/:chatId/approve', (req, res) => {
    const { requestId, decision } = req.body;
    if (!requestId || !decision) {
      res.status(400).json({ error: 'requestId and decision required' });
      return;
    }
    if (!['allow', 'deny', 'abort'].includes(decision)) {
      res.status(400).json({ error: 'decision must be allow, deny, or abort' });
      return;
    }

    const pending = pendingApprovals.get(requestId);
    if (!pending) {
      res.status(404).json({ error: `No pending approval with requestId "${requestId}"` });
      return;
    }
    if (pending.chatId !== req.params.chatId) {
      res.status(400).json({ error: 'requestId does not belong to this chat' });
      return;
    }

    console.log(`[Web] Tool approval: ${pending.toolName} → ${decision} (requestId=${requestId})`);
    pending.resolve(decision);
    pendingApprovals.delete(requestId);
    res.json({ success: true });
  });

  /**
   * POST /api/chat - Stream chat via Server-Sent Events
   *
   * Calls state.chat() directly — no gRPC in the loop.
   * When a tool matches require_approval, an approval_request SSE event is
   * emitted and the stream pauses until POST /api/chat/:chatId/approve resolves it.
   */
  app.post('/api/chat', (req, res) => {
    const { model, messages, temperature, top_p, top_k, max_tokens, timeout: reqTimeout, tools, tool_mode } = req.body;

    if (!model || !messages) {
      res.status(400).json({ error: 'model and messages required' });
      return;
    }

    const chatId = crypto.randomUUID();

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Chat-Id': chatId,
    });
    res.flushHeaders();

    let ended = false;

    const safeWrite = (data: string): boolean => {
      if (ended || res.writableEnded) return false;
      try { res.write(data); return true; } catch { return false; }
    };

    const safeEnd = () => {
      if (!ended && !res.writableEnded) {
        ended = true;
        try { res.end(); } catch { /* ignore */ }
      }
    };

    // Convert web messages to the format state.chat() expects
    const chatMessages = messages.map((m: { role?: string; content?: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] }) => ({
      role: m.role || 'user',
      content: m.content ?? '',
      name: m.name || undefined,
      tool_call_id: m.tool_call_id || undefined,
      tool_calls: m.tool_calls || undefined,
    }));

    // Build request params (per-request overrides)
    const requestParams: Record<string, unknown> = {};
    if (temperature != null) requestParams.temperature = temperature;
    if (top_p != null) requestParams.top_p = top_p;
    if (top_k != null) requestParams.top_k = top_k;
    if (max_tokens != null) requestParams.maxTokens = max_tokens;
    if (reqTimeout != null) requestParams.timeout = reqTimeout;
    const hasParams = Object.keys(requestParams).length > 0;

    // Build tool options
    const toolDefs = Array.isArray(tools) ? tools.map((t: { name?: string; description?: string; input_schema?: string | Record<string, unknown> }) => ({
      name: t.name || '',
      description: t.description || '',
      inputSchema: typeof t.input_schema === 'string' ? t.input_schema : JSON.stringify(t.input_schema || {}),
    })).filter((t) => t.name) : undefined;

    const toolOptions: ChatToolOptions = {
      toolMode: tool_mode || 'auto',
      tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined,
      onToolApprovalNeeded: async (requestId: string, toolName: string, args: unknown, namespacedName?: string): Promise<'allow' | 'deny' | 'abort'> => {
        safeWrite(`data: ${JSON.stringify({ type: 'approval_request', chatId, requestId, toolName, namespacedName, args })}\n\n`);
        return new Promise((resolve) => {
          pendingApprovals.set(requestId, { resolve, toolName, args, chatId });
        });
      },
    };

    // Send chatId as the first SSE event so the client knows where to POST approvals
    safeWrite(`data: ${JSON.stringify({ type: 'chat_started', chatId })}\n\n`);

    const registryCount = state.toolRegistry?.size || 0;
    console.log('[Web] Starting Chat stream:', model, `chatId=${chatId}`, `messages: ${chatMessages.length}`, `tools: ${toolDefs?.length || 0}`, `registry: ${registryCount}`, `toolMode: ${toolOptions.toolMode}`);

    res.on('close', () => {
      if (!ended) {
        ended = true;
        console.log('[Web] Client disconnected during chat stream');
        // Clean up any pending approvals for this chat
        for (const [reqId, pending] of pendingApprovals) {
          if (pending.chatId === chatId) {
            pending.resolve('abort');
            pendingApprovals.delete(reqId);
          }
        }
      }
    });

    (async () => {
      try {
        for await (const chunk of state.chat(model, chatMessages, hasParams ? requestParams : undefined, toolOptions)) {
          if (ended) break;

          if (chunk.type === 'text' && chunk.text) {
            safeWrite(`data: ${JSON.stringify({ type: 'text', content: chunk.text })}\n\n`);
          } else if (chunk.type === 'tool') {
            const toolData: Record<string, unknown> = { type: 'tool', name: chunk.name, state: chunk.state, done: chunk.done };
            if (chunk.call) {
              toolData.call = { params: chunk.call.params, result: chunk.call.result };
            }
            safeWrite(`data: ${JSON.stringify(toolData)}\n\n`);
          } else if (chunk.type === 'approval_request') {
            safeWrite(`data: ${JSON.stringify({ type: 'approval_request', chatId, requestId: chunk.requestId, toolName: chunk.toolName, args: chunk.args })}\n\n`);
          } else if (chunk.type === 'approval_result') {
            safeWrite(`data: ${JSON.stringify({ type: 'approval_result', requestId: chunk.requestId, decision: chunk.decision })}\n\n`);
          } else if (chunk.type === 'error') {
            safeWrite(`data: ${JSON.stringify({ type: 'error', error: chunk.error })}\n\n`);
          } else if (chunk.type === 'done') {
            safeWrite(`data: ${JSON.stringify({ type: 'done', finish_reason: chunk.finishReason || 'stop' })}\n\n`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Web] Chat stream error:', msg);
        safeWrite(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`);
      } finally {
        safeWrite('data: [DONE]\n\n');
        safeEnd();
        // Clean up any remaining pending approvals
        for (const [reqId, pending] of pendingApprovals) {
          if (pending.chatId === chatId) {
            pendingApprovals.delete(reqId);
          }
        }
      }
    })();
  });
  
  /**
   * POST /api/provider/:id/configure - Configure a provider (set API key + update config)
   */
  app.post('/api/provider/:id/configure', async (req, res) => {
    try {
      const providerId = req.params.id;
      const { engine, apiKey, envVarName, baseUrl, target, workspacePath } = req.body;
      
      const config: ConfigFile = (target === 'workspace' && workspacePath
        ? loadWorkspaceConfig(workspacePath)
        : loadConfig()) || { providers: {} };
      
      if (!config.providers) config.providers = {};
      
      // Initialize or update provider config
      const existing: Partial<ProviderConfig> & { display_name?: string } = config.providers[providerId] ? { ...config.providers[providerId] } : {};
      if (engine) existing.engine = engine;
      delete existing.display_name;
      config.providers[providerId] = existing as ProviderConfig;
      
      if (apiKey) {
        const keychainName = `${providerId.toUpperCase()}_API_KEY`;
        await state.secretStore.set(keychainName, apiKey);
        config.providers[providerId].api_key_keychain_name = keychainName;
        delete config.providers[providerId].api_key_env_var_name;
      } else if (envVarName) {
        config.providers[providerId].api_key_env_var_name = envVarName;
        delete config.providers[providerId].api_key_keychain_name;
      }
      
      if (baseUrl) {
        config.providers[providerId].base_url = baseUrl;
      }
      
      if (target === 'workspace' && workspacePath) {
        saveWorkspaceConfig(workspacePath, config);
      } else {
        saveConfig(config);
      }
      
      res.json({ success: true });
      state.notifyModelsChanged('provider_configured');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/provider configure error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  /**
   * DELETE /api/provider/:id - Remove a provider configuration
   */
  app.delete('/api/provider/:id', async (req, res) => {
    try {
      const providerId = req.params.id;
      const target = req.query.target as string || 'user';
      const workspacePath = req.query.workspacePath as string;
      
      const config: ConfigFile = (target === 'workspace' && workspacePath
        ? loadWorkspaceConfig(workspacePath)
        : loadConfig()) || { providers: {} };
      
      if (config.providers && config.providers[providerId]) {
        const keychainName = config.providers[providerId].api_key_keychain_name;
        if (keychainName) {
          try { await state.secretStore.delete(keychainName); } catch { /* ignore */ }
        }
        
        delete config.providers[providerId];
        
        if (target === 'workspace' && workspacePath) {
          saveWorkspaceConfig(workspacePath, config);
        } else {
          saveConfig(config);
        }
      }
      
      res.json({ success: true });
      state.notifyModelsChanged('provider_removed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] /api/provider delete error:', msg);
      res.status(500).json({ error: msg });
    }
  });
  
  // ── MCP Server Management ──────────────────────────────────────────────

  // GET /api/mcp-servers — list configured MCP servers with connection status
  app.get('/api/mcp-servers', (_req, res) => {
    try {
      const statuses = state.mcpClientPool.getStatuses();
      // Also include servers from config that might not have a status yet (disabled ones)
      const config = loadConfig();
      const mcpCfg = config.mcp_servers || {};
      const statusMap = new Map(statuses.map(s => [s.id, s]));
      
      const result = [];
      // Add configured servers (with status if available)
      for (const [id, cfg] of Object.entries(mcpCfg)) {
        const st = statusMap.get(id);
        result.push({
          id,
          transport: cfg.transport || 'stdio',
          enabled: cfg.enabled !== false,
          status: st ? (st.connected ? 'connected' : (st.error ? 'error' : 'disconnected')) : (cfg.enabled === false ? 'disabled' : 'not started'),
          toolCount: st?.toolCount || 0,
          error: st?.error || null,
        });
      }
      // Add any statuses that aren't in config (shouldn't happen, but just in case)
      for (const st of statuses) {
        if (!mcpCfg[st.id]) {
          result.push({
            id: st.id,
            transport: st.config?.transport || 'stdio',
            enabled: st.config?.enabled !== false,
            status: st.connected ? 'connected' : (st.error ? 'error' : 'disconnected'),
            toolCount: st.toolCount || 0,
            error: st.error || null,
          });
        }
      }
      
      res.json({ mcp_servers: result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/mcp-servers/:id/reconnect — reconnect a failed MCP server
  app.post('/api/mcp-servers/:id/reconnect', async (req, res) => {
    try {
      await state.mcpClientPool.reconnect(req.params.id);
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/tools — list all registered tools from the registry
  app.get('/api/tools', (_req, res) => {
    try {
      const tools = state.toolRegistry?.getAll() || [];
      res.json({
        tools: tools.map(t => ({
          name: t.namespacedName,
          originalName: t.originalName,
          source: t.source,
          sourceType: t.sourceType,
          description: t.description,
        })),
        total: tools.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Policy Management ──────────────────────────────────────────────────

  // GET /api/policies — list all policies (built-in + custom)
  app.get('/api/policies', (_req, res) => {
    try {
      const policies = listAllPolicies();
      res.json({ policies });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/policies — upsert a custom policy
  app.post('/api/policies', (req, res) => {
    try {
      const { name, config } = req.body as { name: string; config: PolicyConfig };
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Policy name is required' });
        return;
      }
      if (!isValidVirtualName(name)) {
        res.status(400).json({ error: 'Policy name must be lowercase alphanumeric with dots, hyphens, or underscores' });
        return;
      }
      if (BUILTIN_POLICY_NAMES.includes(name)) {
        res.status(400).json({ error: `Cannot overwrite built-in policy "${name}". Duplicate it with a different name.` });
        return;
      }
      if (!config || typeof config !== 'object') {
        res.status(400).json({ error: 'Policy config is required' });
        return;
      }

      const custom = loadCustomPolicies();
      custom[name] = config;
      saveCustomPolicies(custom);
      res.json({ success: true, name });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // DELETE /api/policies/:name — delete a custom policy
  app.delete('/api/policies/:name', (req, res) => {
    try {
      const { name } = req.params;
      if (BUILTIN_POLICY_NAMES.includes(name)) {
        res.status(400).json({ error: `Cannot delete built-in policy "${name}"` });
        return;
      }
      const custom = loadCustomPolicies();
      if (!(name in custom)) {
        res.status(404).json({ error: `Custom policy "${name}" not found` });
        return;
      }
      delete custom[name];
      saveCustomPolicies(custom);
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/mcp-server/status — MCP server (our exposed server) status
  app.get('/api/mcp-server/status', (_req, res) => {
    res.json({
      running: state.mcpServer.isRunning,
    });
  });

  // POST /api/mcp-server/start — start the MCP server on this Express app
  app.post('/api/mcp-server/start', async (_req, res) => {
    try {
      if (state.mcpServer.isRunning) {
        res.json({ success: true, message: 'MCP server already running' });
        return;
      }
      await state.mcpServer.start(app);
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/mcp-server/stop — stop the MCP server
  app.post('/api/mcp-server/stop', async (_req, res) => {
    try {
      await state.mcpServer.stop();
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Session Management ───────────────────────────────────────────────

  const sessionOwner = (req: Request): string =>
    (req as RequestWithOwner).abbenayOwner || LOCAL_SESSION_OWNER;

  app.post('/api/sessions', async (req, res) => {
    try {
      const { model, title, policy, metadata } = req.body;
      if (!model) {
        res.status(400).json({ error: 'model is required' });
        return;
      }
      const session = await state.sessionStore.create(
        model,
        title,
        policy,
        metadata,
        sessionOwner(req),
      );
      res.json(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] POST /api/sessions error:', msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/sessions', async (req, res) => {
    try {
      const model = req.query.model as string | undefined;

      let limit: number | undefined;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
          res.status(400).json({ error: 'Invalid "limit": must be a non-negative integer' });
          return;
        }
      }

      let offset: number | undefined;
      if (req.query.offset !== undefined) {
        offset = Number(req.query.offset);
        if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
          res.status(400).json({ error: 'Invalid "offset": must be a non-negative integer' });
          return;
        }
      }

      const result = await state.sessionStore.list({
        model,
        limit,
        offset,
        owner: sessionOwner(req),
      });
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Web] GET /api/sessions error:', msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const includeMessages = req.query.includeMessages !== 'false';
      const session = await state.sessionStore.getOwned(
        req.params.id,
        sessionOwner(req),
        includeMessages,
      );
      res.json(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('Invalid session ID')) {
        res.status(404).json({ error: msg });
      } else {
        console.error('[Web] GET /api/sessions/:id error:', msg);
        res.status(500).json({ error: msg });
      }
    }
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      await state.sessionStore.deleteOwned(req.params.id, sessionOwner(req));
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('Invalid session ID')) {
        res.status(404).json({ error: msg });
      } else {
        console.error('[Web] DELETE /api/sessions/:id error:', msg);
        res.status(500).json({ error: msg });
      }
    }
  });

  app.get('/api/sessions/:id/summary', async (req, res) => {
    try {
      const session = await state.sessionStore.getOwned(req.params.id, sessionOwner(req), true);
      const userCount = session.messages.filter((m) => m.role === 'user').length;

      if (session.summary && session.summaryMessageCount === userCount) {
        res.json({ summary: session.summary, from_cache: true });
        return;
      }

      const model = req.query.model as string | undefined;
      const summary = await generateSessionSummary(state, session, model);
      if (summary) {
        await state.sessionStore.updateSummary(req.params.id, summary, userCount);
      }
      res.json({ summary, from_cache: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('Invalid session ID')) {
        res.status(404).json({ error: msg });
      } else {
        console.error('[Web] GET /api/sessions/:id/summary error:', msg);
        res.status(500).json({ error: msg });
      }
    }
  });

  app.post('/api/sessions/:id/chat', async (req, res) => {
    const sessionId = req.params.id;
    const { message } = req.body;
    const owner = sessionOwner(req);

    if (!message || !message.content) {
      res.status(400).json({ error: 'message with content is required' });
      return;
    }

    const chatMessage = {
      role: (message.role as string) || 'user',
      content: message.content as string,
    };

    let session;
    try {
      session = await state.sessionStore.getOwned(sessionId, owner, true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('Invalid session ID')) {
        res.status(404).json({ error: msg });
      } else {
        console.error('[Web] POST /api/sessions/:id/chat error:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    let ended = false;
    const safeWrite = (data: string): boolean => {
      if (ended || res.writableEnded) return false;
      try { res.write(data); return true; } catch { return false; }
    };
    const safeEnd = () => {
      if (!ended && !res.writableEnded) {
        ended = true;
        try { res.end(); } catch { /* ignore */ }
      }
    };

    res.on('close', () => { ended = true; });

    (async () => {
      try {
        await state.sessionStore.appendMessage(sessionId, chatMessage);

        const allMessages = [...session.messages, chatMessage];
        let fullText = '';

        const toolOptions: ChatToolOptions = { toolMode: 'none' };
        for await (const chunk of state.chat(session.model, allMessages, undefined, toolOptions)) {
          if (ended) break;
          if (chunk.type === 'text' && chunk.text) {
            fullText += chunk.text;
            safeWrite(`data: ${JSON.stringify({ type: 'text', content: chunk.text })}\n\n`);
          } else if (chunk.type === 'tool') {
            const toolData: Record<string, unknown> = { type: 'tool', name: chunk.name, state: chunk.state, done: chunk.done };
            if (chunk.call) {
              toolData.call = { params: chunk.call.params, result: chunk.call.result };
            }
            safeWrite(`data: ${JSON.stringify(toolData)}\n\n`);

            if (chunk.done && chunk.call) {
              const callId = `call_${chunk.name}_${Date.now()}`;
              await state.sessionStore.appendMessage(sessionId, {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: callId, name: chunk.name, arguments: chunk.call.params ? JSON.stringify(chunk.call.params) : '{}' }],
              });
              await state.sessionStore.appendMessage(sessionId, {
                role: 'tool',
                name: chunk.name,
                content: typeof chunk.call.result === 'string' ? chunk.call.result : JSON.stringify(chunk.call.result || {}),
                tool_call_id: callId,
              });
            }
          } else if (chunk.type === 'error') {
            safeWrite(`data: ${JSON.stringify({ type: 'error', error: chunk.error })}\n\n`);
          } else if (chunk.type === 'done') {
            safeWrite(`data: ${JSON.stringify({ type: 'done', finish_reason: chunk.finishReason || 'stop' })}\n\n`);
          }
        }

        if (fullText) {
          await state.sessionStore.appendMessage(sessionId, { role: 'assistant', content: fullText });
        }

        if (session.messages.length === 0 && session.title === 'New Session') {
          const title = chatMessage.content.substring(0, 60).replace(/\n/g, ' ').trim();
          if (title) {
            await state.sessionStore.updateTitle(sessionId, title);
          }
        }

        void maybeSummarize(state, sessionId, state.sessionStore);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Web] Session chat error:', msg);
        safeWrite(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`);
      } finally {
        safeWrite('data: [DONE]\n\n');
        safeEnd();
      }
    })();
  });

  // ── OpenAI-compatible API (/v1/*) ─────────────────────────────────────
  registerOpenAIRoutes(app, state);

  return app;
}

// ─── Embedded Web Server Lifecycle ──────────────────────────────────────

let _httpServer: http.Server | null = null;
let _webPort: number | null = null;
let _webHost: string | null = null;
let _lastApp: Express | null = null;
let _lastSecurity: ResolvedHttpSecurity | null = null;

/**
 * Start the embedded web server in the daemon process.
 * Returns the actual port, URL, app, and resolved security settings.
 *
 * Binds to 127.0.0.1 by default. Non-localhost bind requires explicit opt-in
 * via `host`, `ABBENAY_HTTP_HOST`, or `server.host` in config.yaml.
 */
export async function startEmbeddedWebServer(
  state: DaemonState,
  port: number = DEFAULT_WEB_PORT,
  host?: string,
  options?: WebSecurityOptions,
): Promise<{ port: number; url: string; app: Express; security: ResolvedHttpSecurity }> {
  if (_httpServer) {
    return {
      port: _webPort!,
      url: `http://${_webHost === '0.0.0.0' ? '127.0.0.1' : _webHost}:${_webPort}`,
      app: _lastApp!,
      security: _lastSecurity!,
    };
  }

  const security = resolveHttpSecurity(port, host, options);
  const bindHost = security.host || DEFAULT_HTTP_HOST;
  assertHttpAuthBindAllowed(bindHost, security.authEnabled);
  const app = createWebApp(state, {
    ...options,
    apiToken: security.apiToken,
    port,
    host: bindHost,
    corsOrigins: security.corsOrigins,
    skipConfig: true,
  });

  // SPA fallback (serve index.html for non-API routes)
  app.get('*', (req, res) => {
    const indexPath = path.join(STATIC_PATH, 'index.html');
    if (!fs.existsSync(indexPath)) {
      res.status(404).send('Web dashboard not found. Static files not at: ' + STATIC_PATH);
      return;
    }
    if (!security.authEnabled) {
      res.type('html').send(fs.readFileSync(indexPath, 'utf-8'));
      return;
    }
    const addr = req.socket.remoteAddress || '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const cookieToken = getCookie(req, API_TOKEN_COOKIE);
    const hasAuthCookie =
      cookieToken !== null && timingSafeEqualString(cookieToken, security.apiToken);
    const mayEstablish = hasAuthCookie || loopback || isLocalhostBind(bindHost);
    let csrf = getCookie(req, CSRF_COOKIE);
    if (mayEstablish && (!hasAuthCookie || !csrf)) {
      csrf = setAuthCookies(res, security.apiToken, { secure: cookieSecureFromRequest(req) });
    }
    let html = fs.readFileSync(indexPath, 'utf-8');
    const inject = `<script>window.__ABBENAY_CSRF__=${JSON.stringify(csrf || '')};</script>`;
    html = html.includes('</head>')
      ? html.replace('</head>', `${inject}</head>`)
      : `${inject}${html}`;
    res.type('html').send(html);
  });

  _webPort = port;
  _webHost = bindHost;

  if (!security.authEnabled) {
    console.warn(
      '[Web] WARNING: HTTP authentication is DISABLED (ABBENAY_HTTP_AUTH). ' +
      'Any local process (and any site that can reach this bind address) can ' +
      'read/write secrets, config, chat, MCP, and sessions. ' +
      'Re-enable auth for anything beyond throwaway local development.',
    );
  }

  if (!isLocalhostBind(bindHost)) {
    console.warn(
      `[Web] WARNING: HTTP server is bound to ${bindHost} — accessible beyond loopback. ` +
      'Ensure ABBENAY_API_TOKEN (or server.api_token) is set and CORS origins are restricted. ' +
      'Prefer --host 127.0.0.1 unless you intentionally expose the API.',
    );
  }

  await new Promise<void>((resolve, reject) => {
    _httpServer = app.listen(port, bindHost, () => {
      const displayHost = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost;
      console.log(`[Web] Dashboard started: http://${displayHost}:${port} (bind ${bindHost})`);
      if (security.authEnabled) {
        if (security.generated) {
          console.log(
            '[Web] Generated API token and saved to config dir (http-api-token). ' +
            'Prefer setting ABBENAY_API_TOKEN explicitly in containers — auto-generated ' +
            'tokens are hard to retrieve from inside the image.',
          );
        }
        console.log(`[Web] Authenticate with: Authorization: Bearer <token>`);
        console.log(`[Web] Dashboard login: http://${displayHost}:${port}/login`);
      } else {
        console.log(`[Web] HTTP auth disabled — requests are accepted without a Bearer token`);
      }
      resolve();
    });
    _httpServer.on('error', reject);
  });

  _lastApp = app;
  _lastSecurity = security;
  const displayHost = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost;
  return {
    port,
    url: `http://${displayHost}:${port}`,
    app,
    security,
  };
}

/**
 * Stop the embedded web server.
 */
export async function stopEmbeddedWebServer(): Promise<void> {
  if (!_httpServer) return;
  
  await new Promise<void>((resolve) => {
    _httpServer!.close(() => {
      console.log('[Web] Dashboard stopped');
      resolve();
    });
  });
  
  _httpServer = null;
  _webPort = null;
  _webHost = null;
  _lastApp = null;
  _lastSecurity = null;
}

/**
 * Check if the embedded web server is running.
 */
export function isWebServerRunning(): boolean {
  return _httpServer !== null;
}

/**
 * Get the current web server port (null if not running).
 */
export function getWebServerPort(): number | null {
  return _webPort;
}
