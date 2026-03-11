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

import express, { type Express } from 'express';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDefaultSocketPath } from '../transport.js';
import { loadConfig, saveConfig, loadWorkspaceConfig, saveWorkspaceConfig, getUserConfigPath, getWorkspaceConfigPath, isValidVirtualName, type ConfigFile } from '../../core/config.js';
import { listAllPolicies, loadCustomPolicies, saveCustomPolicies, BUILTIN_POLICY_NAMES, type PolicyConfig } from '../../core/policies.js';
import type { DaemonState } from '../state.js';
import type { ChatToolOptions } from '../../core/state.js';
import { getEngines, getEngine, getProviderTemplates } from '../../core/engines.js';

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
 */
export function createWebApp(state: DaemonState): Express {
  const app = express();
  
  // Parse JSON bodies
  app.use(express.json());
  
  // CORS for local development
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });
  
  // Prevent browser caching of HTML so dashboard always serves fresh content
  app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
  });

  // Serve static files
  if (fs.existsSync(STATIC_PATH)) {
    app.use(express.static(STATIC_PATH));
  }
  
  // ─── API Routes ────────────────────────────────────────────────────────
  
  /**
   * GET /api/health - Health check
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
    } catch (err: any) {
      console.error('[Web] /api/providers error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/discover-models error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/models error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/config GET error:', err.message);
      res.status(500).json({ error: err.message });
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
      state.refreshMcpConnections().catch((err: any) => {
        console.error('[Web] MCP refresh after config change failed:', err.message);
      });
    } catch (err: any) {
      console.error('[Web] /api/config POST error:', err.message);
      res.status(500).json({ error: err.message });
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
            const ws = await state.requestWorkspace(connId);
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
    } catch (err: any) {
      console.error('[Web] /api/workspaces error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/status error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/secrets error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/secrets POST error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/secrets POST error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/secrets DELETE error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      console.error('[Web] /api/key-status error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // ── Tool approval gate for pending chat requests ────────────────────────

  const pendingApprovals = new Map<string, {
    resolve: (decision: 'allow' | 'deny' | 'abort') => void;
    toolName: string;
    args: any;
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
        try { res.end(); } catch {}
      }
    };

    // Convert web messages to the format state.chat() expects
    const chatMessages = messages.map((m: any) => ({
      role: m.role || 'user',
      content: m.content || '',
      name: m.name || undefined,
      tool_call_id: m.tool_call_id || undefined,
      tool_calls: m.tool_calls || undefined,
    }));

    // Build request params (per-request overrides)
    const requestParams: Record<string, any> = {};
    if (temperature != null) requestParams.temperature = temperature;
    if (top_p != null) requestParams.top_p = top_p;
    if (top_k != null) requestParams.top_k = top_k;
    if (max_tokens != null) requestParams.maxTokens = max_tokens;
    if (reqTimeout != null) requestParams.timeout = reqTimeout;
    const hasParams = Object.keys(requestParams).length > 0;

    // Build tool options
    const toolDefs = Array.isArray(tools) ? tools.map((t: any) => ({
      name: t.name || '',
      description: t.description || '',
      inputSchema: typeof t.input_schema === 'string' ? t.input_schema : JSON.stringify(t.input_schema || {}),
    })).filter((t: any) => t.name) : undefined;

    const toolOptions: ChatToolOptions = {
      toolMode: tool_mode || 'auto',
      tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined,
      onToolApprovalNeeded: async (requestId: string, toolName: string, args: any): Promise<'allow' | 'deny' | 'abort'> => {
        safeWrite(`data: ${JSON.stringify({ type: 'approval_request', chatId, requestId, toolName, args })}\n\n`);
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
            const toolData: any = { type: 'tool', name: chunk.name, state: chunk.state, done: chunk.done };
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
      } catch (err: any) {
        console.error('[Web] Chat stream error:', err.message);
        safeWrite(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
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
      const existing: any = config.providers[providerId] || {};
      if (engine) existing.engine = engine;
      delete existing.display_name; // clean up legacy field
      config.providers[providerId] = existing;
      
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
    } catch (err: any) {
      console.error('[Web] /api/provider configure error:', err.message);
      res.status(500).json({ error: err.message });
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
          try { await state.secretStore.delete(keychainName); } catch {}
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
    } catch (err: any) {
      console.error('[Web] /api/provider delete error:', err.message);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/mcp-servers/:id/reconnect — reconnect a failed MCP server
  app.post('/api/mcp-servers/:id/reconnect', async (req, res) => {
    try {
      await state.mcpClientPool.reconnect(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Policy Management ──────────────────────────────────────────────────

  // GET /api/policies — list all policies (built-in + custom)
  app.get('/api/policies', (_req, res) => {
    try {
      const policies = listAllPolicies();
      res.json({ policies });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/mcp-server/stop — stop the MCP server
  app.post('/api/mcp-server/stop', async (_req, res) => {
    try {
      await state.mcpServer.stop();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// ─── Embedded Web Server Lifecycle ──────────────────────────────────────

let _httpServer: http.Server | null = null;
let _webPort: number | null = null;
let _lastApp: Express | null = null;

/**
 * Start the embedded web server in the daemon process.
 * Returns the actual port and URL.
 */
export async function startEmbeddedWebServer(
  state: DaemonState,
  port: number = 8787,
): Promise<{ port: number; url: string; app: Express }> {
  if (_httpServer) {
    return { port: _webPort!, url: `http://localhost:${_webPort}`, app: _lastApp! };
  }
  
  const app = createWebApp(state);
  
  // SPA fallback (serve index.html for non-API routes)
  app.get('*', (req, res) => {
    const indexPath = path.join(STATIC_PATH, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Web dashboard not found. Static files not at: ' + STATIC_PATH);
    }
  });
  
  _webPort = port;
  
  await new Promise<void>((resolve, reject) => {
    _httpServer = app.listen(port, () => {
      console.log(`[Web] Dashboard started: http://localhost:${port}`);
      resolve();
    });
    _httpServer.on('error', reject);
  });
  
  _lastApp = app;
  return { port, url: `http://localhost:${port}`, app };
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
