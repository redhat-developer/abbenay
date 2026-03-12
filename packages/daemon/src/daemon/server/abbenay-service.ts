/**
 * Abbenay gRPC service implementation
 */

import * as grpc from '@grpc/grpc-js';
import { DaemonState, ClientType, type ChatToolOptions } from '../state.js';
import { getEngines, type ToolDefinition } from '../../core/engines.js';
import {
  startEmbeddedWebServer,
  stopEmbeddedWebServer,
  isWebServerRunning,
  getWebServerPort,
} from '../web/server.js';
import { listAllPolicies, type PolicyConfig as PolicyCfg } from '../../core/policies.js';

interface ProtoClientInfo {
  client_type?: string | number;
  client_id?: string;
  user?: string;
}

interface RegisterRequestProto {
  client?: ProtoClientInfo;
  client_type?: string | number;
  is_spawner?: boolean;
  workspace_path?: string;
}

interface UnregisterRequestProto {
  client_id: string;
}

interface ListModelsRequestProto {
  workspace_paths?: string[];
  workspacePaths?: string[];
}

interface DiscoverModelsRequestProto {
  engine_id?: string;
  engineId?: string;
  provider_id?: string;
  api_key?: string;
  apiKey?: string;
  base_url?: string;
  baseUrl?: string;
}

interface ProtoMessage {
  role?: string | number;
  content?: string;
  name?: string;
  tool_call_id?: string;
  toolCallId?: string;
  tool_calls?: unknown[];
  toolCalls?: unknown[];
}

interface ChatOptionsProto {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  timeout?: number;
  tool_mode?: string;
  toolMode?: string;
  max_tool_iterations?: number;
  maxToolIterations?: number;
}

interface ProtoTool {
  name?: string;
  description?: string;
  input_schema?: string;
  inputSchema?: string;
}

interface ChatRequestProto {
  model?: string;
  messages?: ProtoMessage[];
  options?: ChatOptionsProto;
  tools?: ProtoTool[];
}

interface GetSecretRequestProto {
  key: string;
}

interface SetSecretRequestProto {
  key: string;
  value: string;
}

interface DeleteSecretRequestProto {
  key: string;
}

interface GetProviderStatusRequestProto {
  provider_id: string;
}

interface StartWebServerRequestProto {
  port?: number;
}

interface CreateSessionRequestProto {
  model?: string;
  topic?: string;
  metadata?: Record<string, string>;
}

interface GetSessionRequestProto {
  session_id?: string;
  sessionId?: string;
  include_messages?: boolean;
  includeMessages?: boolean;
}

interface ListSessionsRequestProto {
  limit?: number;
  offset?: number;
  model_filter?: string;
  modelFilter?: string;
}

interface DeleteSessionRequestProto {
  session_id?: string;
  sessionId?: string;
}

interface SessionChatRequestProto {
  session_id?: string;
  sessionId?: string;
  message?: ProtoMessage;
  options?: ChatOptionsProto;
}

interface VSCodeResponseProto {
  register_tools?: { tools: unknown[] };
  registerTools?: { tools: unknown[] };
  [key: string]: unknown;
}

interface ProviderConfigOutput {
  enabled: boolean;
  engine: string;
  api_key_ref: string;
  base_url: string;
}

interface PolicyProtoOutput {
  sampling?: { temperature?: number; top_p?: number; top_k?: number };
  output?: {
    max_tokens?: number;
    reserved_output_tokens?: number;
    format?: string;
    system_prompt_snippet?: string;
    system_prompt_mode?: string;
  };
  context?: { context_threshold?: number; compression_strategy?: string };
  tool?: { max_tool_iterations?: number; tool_mode?: string };
  reliability?: { retry_on_invalid_json?: boolean; timeout?: number };
}

interface RequestParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  maxTokens?: number;
  timeout?: number;
}

/**
 * Map proto client type to enum
 */
function toClientType(protoType: string | number): ClientType {
  switch (protoType) {
    case 'CLIENT_TYPE_VSCODE':
    case 1:
      return ClientType.VSCODE;
    case 'CLIENT_TYPE_CLI':
    case 2:
      return ClientType.CLI;
    case 'CLIENT_TYPE_PYTHON':
    case 3:
      return ClientType.PYTHON;
    case 'CLIENT_TYPE_NODEJS':
    case 4:
      return ClientType.NODEJS;
    case 'CLIENT_TYPE_MCP':
    case 5:
      return ClientType.MCP;
    default:
      return ClientType.UNSPECIFIED;
  }
}

/**
 * Map proto role to string
 */
function toRole(protoRole: string | number): string {
  switch (protoRole) {
    case 'ROLE_SYSTEM':
    case 0:
      return 'system';
    case 'ROLE_USER':
    case 1:
      return 'user';
    case 'ROLE_ASSISTANT':
    case 2:
      return 'assistant';
    case 'ROLE_TOOL':
    case 3:
      return 'tool';
    default:
      return 'user';
  }
}

/**
 * Create the Abbenay service handlers
 */
export function createAbbenayService(state: DaemonState) {
  return {
    /**
     * Register a client with the daemon
     */
    Register(
      call: grpc.ServerUnaryCall<RegisterRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const request = call.request;
      
      // Proto: RegisterRequest { ClientInfo client = 1; bool is_spawner = 2; string workspace_path = 3; }
      // ClientInfo { ClientType client_type = 1; string client_id = 2; string user = 3; }
      const clientInfo = request.client || {};
      const clientType = toClientType((clientInfo.client_type ?? request.client_type ?? 'CLIENT_TYPE_CLI') as string | number);
      
      const clientId = state.registerClient(
        clientType,
        request.is_spawner || false,
        request.workspace_path || undefined
      );
      
      callback(null, {
        client_id: clientId,
        connected_clients: state.clientCount,
      });
    },
    
    /**
     * Unregister a client
     */
    Unregister(
      call: grpc.ServerUnaryCall<UnregisterRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      state.unregisterClient(call.request.client_id);
      callback(null, {});
    },
    
    /**
     * List providers
     */
    ListProviders(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      state.listProviders().then((providers) => {
        callback(null, {
          providers: providers.map((p) => ({
            id: p.id,
            engine: p.engine,
            configured: p.configured,
            healthy: p.healthy,
            requires_key: p.requiresKey,
            default_base_url: p.defaultBaseUrl,
            base_url: p.baseUrl,
          })),
        });
      }).catch((error: unknown) => {
        console.error('[gRPC] ListProviders error:', error);
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * List models (dynamic from provider APIs, workspace-aware, config-gated)
     */
    ListModels(
      call: grpc.ServerUnaryCall<ListModelsRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const workspacePaths = call.request.workspace_paths || call.request.workspacePaths || [];
      state.listModels(workspacePaths).then((models) => {
        callback(null, {
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            engine_model_id: m.engineModelId,
            provider: m.provider,
            engine: m.engine,
            context_window: m.contextWindow,
            capabilities: {
              supports_tools: m.capabilities?.supportsTools || false,
              supports_vision: m.capabilities?.supportsVision || false,
            },
            params: m.params ? {
              temperature: m.params.temperature,
              top_p: m.params.top_p,
              max_tokens: m.params.max_tokens,
              system_prompt: m.params.system_prompt,
              system_prompt_mode: m.params.system_prompt_mode,
              top_k: m.params.top_k,
              timeout: m.params.timeout,
            } : undefined,
            policy: m.params?.policy,
          })),
        });
      }).catch((error: unknown) => {
        console.error('[gRPC] ListModels error:', error);
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Discover all models a provider offers (ignores config, for browsing/selection)
     */
    DiscoverModels(
      call: grpc.ServerUnaryCall<DiscoverModelsRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const engineId = call.request.engine_id || call.request.engineId || call.request.provider_id || '';
      if (!engineId) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'engine_id is required',
        });
        return;
      }
      const apiKey = call.request.api_key || call.request.apiKey || undefined;
      const baseUrl = call.request.base_url || call.request.baseUrl || undefined;
      state.discoverModels(engineId, apiKey, baseUrl).then((models) => {
        callback(null, {
          models: models.map((m) => ({
            id: m.id,
            engine: m.engine,
            context_window: m.contextWindow,
            capabilities: {
              supports_tools: m.capabilities?.supportsTools || false,
              supports_vision: m.capabilities?.supportsVision || false,
            },
          })),
        });
      }).catch((error: unknown) => {
        console.error('[gRPC] DiscoverModels error:', error);
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Streaming chat
     */
    Chat(call: grpc.ServerWritableStream<ChatRequestProto, object>): void {
      const request = call.request;
      const model = request.model;
      
      const messages = (request.messages || []).map((m: ProtoMessage) => ({
        role: toRole((m.role ?? 'ROLE_USER') as string | number),
        content: m.content || '',
        // Preserve tool-related fields for conversation history
        name: m.name || undefined,
        tool_call_id: m.tool_call_id || m.toolCallId || undefined,
        tool_calls: m.tool_calls || m.toolCalls || undefined,
      }));
      
      if (!model) {
        call.write({ error: { code: 'INVALID_ARGUMENT', message: 'Model is required' } });
        call.end();
        return;
      }
      
      // Extract per-request options (3-tier merge: request > config > engine default)
      const opts = request.options || {};
      const requestParams: RequestParams = {};
      if (opts.temperature != null) requestParams.temperature = opts.temperature;
      if (opts.top_p != null) requestParams.top_p = opts.top_p;
      if (opts.top_k != null) requestParams.top_k = opts.top_k;
      if (opts.max_tokens != null) requestParams.maxTokens = opts.max_tokens;
      if (opts.timeout != null) requestParams.timeout = opts.timeout;
      const hasParams = Object.keys(requestParams).length > 0;
      
      // ── Extract tools from proto request ──
      const protoTools: ProtoTool[] = request.tools || [];
      const tools: ToolDefinition[] = protoTools.map((t: ProtoTool) => ({
        name: t.name || '',
        description: t.description || '',
        inputSchema: t.input_schema || t.inputSchema || '{}',
      })).filter((t: ToolDefinition) => t.name); // Filter out empty-name tools
      
      // ── Extract tool mode from options ──
      const toolMode = opts.tool_mode || opts.toolMode || 'auto';
      const maxToolIterations = opts.max_tool_iterations || opts.maxToolIterations || 10;
      
      const toolOptions: ChatToolOptions = {
        toolMode,
        tools: tools.length > 0 ? tools : undefined,
        maxToolIterations,
      };
      
      // Stream the response
      (async () => {
        try {
          for await (const chunk of state.chat(model, messages, hasParams ? requestParams : undefined, toolOptions)) {
            if (chunk.type === 'text' && chunk.text) {
              call.write({ text: { text: chunk.text } });
            } else if (chunk.type === 'tool') {
              // Tool chunk from Vercel AI SDK streamText
              // Shape: { type: 'tool', name, state, status?, call?, done }
              // state: 'running' | 'completed'
              // call: { params, result } — params always present, result when done=true
              if (chunk.call && chunk.done) {
                // Tool execution completed — emit both tool_call and tool_result
                const callId = `call_${chunk.name}_${Date.now()}`;
                call.write({
                  tool_call: {
                    id: callId,
                    name: chunk.name || '',
                    arguments: chunk.call.params ? JSON.stringify(chunk.call.params) : '{}',
                  },
                });
                call.write({
                  tool_result: {
                    tool_call_id: callId,
                    name: chunk.name || '',
                    content: typeof chunk.call.result === 'string' ? chunk.call.result : JSON.stringify(chunk.call.result || {}),
                    is_error: false,
                  },
                });
              } else if (!chunk.done) {
                // Tool in progress — emit a tool_call with what we know
                call.write({
                  tool_call: {
                    id: `call_${chunk.name}_${Date.now()}`,
                    name: chunk.name || '',
                    arguments: chunk.call?.params ? JSON.stringify(chunk.call.params) : '{}',
                  },
                });
              }
            } else if (chunk.type === 'error') {
              call.write({ error: { code: 'INTERNAL', message: chunk.error } });
            } else if (chunk.type === 'done') {
              call.write({ done: { finish_reason: chunk.finishReason || 'stop' } });
            }
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('[gRPC] Chat error:', msg);
          call.write({ error: { code: 'INTERNAL', message: msg } });
        } finally {
          call.end();
        }
      })();
    },
    
    /**
     * Get secret
     */
    GetSecret(
      call: grpc.ServerUnaryCall<GetSecretRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const key = call.request.key;
      
      state.secretStore.get(key).then((value) => {
        callback(null, {
          value: value || '',
          found: value !== null,
        });
      }).catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Set secret
     */
    SetSecret(
      call: grpc.ServerUnaryCall<SetSecretRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const { key, value } = call.request;
      
      state.secretStore.set(key, value).then(() => {
        callback(null, {});
        // Notify VS Code that models may have changed (new API key)
        state.notifyModelsChanged('secret_updated');
      }).catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Delete secret
     */
    DeleteSecret(
      call: grpc.ServerUnaryCall<DeleteSecretRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      state.secretStore.delete(call.request.key).then(() => {
        callback(null, {});
      }).catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * List secrets
     */
    ListSecrets(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      // Return known key names with availability status
      const engines = getEngines();
      const checks = engines.filter(e => e.requiresKey).map(async (e) => {
        const key = e.defaultEnvVar || `${e.id.toUpperCase()}_API_KEY`;
        const hasValue = await state.secretStore.has(key);
        return { key, engine: e.id, has_value: hasValue };
      });
      
      Promise.all(checks).then((secrets) => {
        callback(null, { secrets });
      }).catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Get connected workspaces from VS Code clients
     */
    GetConnectedWorkspaces(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const workspaces = state.getVSCodeWorkspaces();
      callback(null, { workspaces });
    },
    
    /**
     * VS Code bidirectional stream
     * 
     * Proto: rpc VSCodeStream(stream VSCodeResponse) returns (stream VSCodeRequest)
     * - VS Code sends VSCodeResponse messages (input stream)
     * - Daemon sends VSCodeRequest messages (output stream)
     */
    VSCodeStream(call: grpc.ServerDuplexStream<VSCodeResponseProto, object>): void {
      const connId = state.registerVSCodeConnection(call);
      
      console.log(`[gRPC] VS Code stream started: ${connId}`);
      
      // Immediately request workspace info and tools from VS Code
      setTimeout(async () => {
        try {
          console.log(`[gRPC] Requesting workspace from VS Code (${connId})...`);
          const ws = await state.requestWorkspace(connId);
          console.log(`[gRPC] Got workspace: ${ws.workspacePath} (${ws.workspaceFolders.length} folders)`);
          
          // Request available tools after workspace is known (for namespacing)
          try {
            console.log(`[gRPC] Requesting tools from VS Code (${connId})...`);
            await state.requestVSCodeTools(connId);
          } catch (toolErr: unknown) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            console.warn(`[gRPC] Failed to get VS Code tools: ${msg}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[gRPC] Failed to get workspace from VS Code: ${msg}`);
        }
      }, 100);
      
      // Handle incoming responses from VS Code
      call.on('data', (response: VSCodeResponseProto) => {
        console.log(`[gRPC] VS Code response received:`, Object.keys(response));
        
        // Check for unsolicited register_tools notification
        const registerTools = response.register_tools || response.registerTools;
        if (registerTools) {
          state.handleRegisterToolsNotification(connId, registerTools);
          return;
        }
        
        // Route the response to the pending request handler
        state.handleVSCodeResponse(connId, response);
      });
      
      call.on('end', () => {
        console.log(`[gRPC] VS Code stream ended: ${connId}`);
        state.unregisterVSCodeConnection(connId);
        call.end();
      });
      
      call.on('error', (error: Error) => {
        console.error(`[gRPC] VS Code stream error: ${error.message}`);
        state.unregisterVSCodeConnection(connId);
      });
    },
    
    /**
     * Get daemon status
     */
    GetStatus(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const clients = state.getClients();
      
      callback(null, {
        version: state.version,
        started_at: {
          seconds: String(Math.floor(state.startedAt.getTime() / 1000)),
          nanos: 0,
        },
        connected_clients: state.clientCount,
        active_sessions: 0, // Sessions deferred
        clients: clients.map(c => ({
          client_id: c.clientId,
          client_type: c.clientType === 'VSCODE' ? 1 : c.clientType === 'CLI' ? 2 : 0,
          connected_at: {
            seconds: String(Math.floor(c.connectedAt.getTime() / 1000)),
            nanos: 0,
          },
          is_spawner: c.isSpawner,
          workspace_path: c.workspacePath || '',
        })),
      });
    },
    
    /**
     * Health check
     */
    HealthCheck(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      callback(null, {
        healthy: true,
        version: state.version,
      });
    },
    
    /**
     * Get current configuration
     */
    GetConfig(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const config = state.loadProviderConfig();
      
      const providers: Record<string, ProviderConfigOutput> = {};
      for (const [pid, pcfg] of Object.entries(config)) {
        providers[pid] = {
          enabled: true,
          engine: pcfg.engine || pid,
          api_key_ref: pcfg.api_key_keychain_name || pcfg.api_key_env_var_name || '',
          base_url: pcfg.base_url || '',
        };
      }
      
      callback(null, {
        default_model: '',
        providers,
        session_ttl_days: 0,
        log_level: 3, // INFO
      });
    },
    
    /**
     * Update configuration (not fully implemented yet)
     */
    UpdateConfig(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      // For now, just return the existing config
      const _config = state.loadProviderConfig();
      callback(null, {
        default_model: '',
        providers: {},
        session_ttl_days: 0,
        log_level: 3,
      });
      // Notify VS Code that models may have changed
      state.notifyModelsChanged('config_changed');
    },
    
    /**
     * List available engines (API implementations)
     */
    ListEngines(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const engines = getEngines();
      callback(null, {
        engines: engines.map(e => ({
          id: e.id,
          requires_key: e.requiresKey,
          default_base_url: e.defaultBaseUrl,
          default_env_var: e.defaultEnvVar,
        })),
      });
    },
    
    /**
     * Get provider status
     */
    GetProviderStatus(
      call: grpc.ServerUnaryCall<GetProviderStatusRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const providerId = call.request.provider_id;
      
      state.listProviders().then(providers => {
        const provider = providers.find(p => p.id === providerId);
        if (!provider) {
          callback({ code: grpc.status.NOT_FOUND, message: `Provider not found: ${providerId}` });
          return;
        }
        callback(null, {
          provider_id: providerId,
          configured: provider.configured,
          healthy: provider.healthy,
        });
      }).catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Start the embedded web server
     */
    StartWebServer(
      call: grpc.ServerUnaryCall<StartWebServerRequestProto, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      const port = call.request.port || 8787;
      
      if (isWebServerRunning()) {
        const currentPort = getWebServerPort();
        callback(null, {
          started: false,
          already_running: true,
          port: currentPort,
          url: `http://localhost:${currentPort}`,
        });
        return;
      }
      
      startEmbeddedWebServer(state, port).then(({ port: actualPort, url }) => {
        callback(null, {
          started: true,
          already_running: false,
          port: actualPort,
          url,
        });
      }).catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        callback({
          code: grpc.status.INTERNAL,
          message: `Failed to start web server: ${msg}`,
        });
      });
    },
    
    /**
     * Stop the embedded web server
     */
    StopWebServer(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      stopEmbeddedWebServer().then(() => {
        callback(null, {});
      }).catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    
    /**
     * Shutdown the daemon
     */
    Shutdown(
      call: grpc.ServerUnaryCall<object, object>,
      callback: grpc.sendUnaryData<object>
    ): void {
      console.log('[gRPC] Shutdown requested');
      callback(null, {});
      
      setTimeout(() => {
        process.emit('SIGTERM', 'SIGTERM');
      }, 100);
    },
    
    // ─── Session RPCs ──────────────────────────────────────────────────────

    CreateSession(
      call: grpc.ServerUnaryCall<CreateSessionRequestProto, object>,
      callback: grpc.sendUnaryData<object>,
    ): void {
      const { model, topic, metadata } = call.request;
      if (!model) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: 'model is required' });
        return;
      }
      state.sessionStore.create(model, topic || undefined, undefined, metadata).then((session) => {
        callback(null, sessionToProto(session));
      }).catch((error: unknown) => {
        callback({ code: grpc.status.INTERNAL, message: error instanceof Error ? error.message : String(error) });
      });
    },

    GetSession(
      call: grpc.ServerUnaryCall<GetSessionRequestProto, object>,
      callback: grpc.sendUnaryData<object>,
    ): void {
      const id = call.request.session_id || call.request.sessionId || '';
      const includeMessages = call.request.include_messages ?? call.request.includeMessages ?? true;
      if (!id) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: 'session_id is required' });
        return;
      }
      state.sessionStore.get(id, includeMessages).then((session) => {
        callback(null, sessionToProto(session));
      }).catch((error: unknown) => {
        callback({ code: grpc.status.NOT_FOUND, message: error instanceof Error ? error.message : String(error) });
      });
    },

    ListSessions(
      call: grpc.ServerUnaryCall<ListSessionsRequestProto, object>,
      callback: grpc.sendUnaryData<object>,
    ): void {
      const model = call.request.model_filter || call.request.modelFilter || undefined;
      const rawLimit = call.request.limit;
      const rawOffset = call.request.offset;
      const limit = rawLimit == null || rawLimit < 0 ? undefined : rawLimit;
      const offset = rawOffset == null || rawOffset < 0 ? undefined : rawOffset;
      state.sessionStore.list({ model, limit, offset }).then((result) => {
        callback(null, {
          sessions: result.sessions.map(summaryToProto),
          total_count: result.totalCount,
        });
      }).catch((error: unknown) => {
        callback({ code: grpc.status.INTERNAL, message: error instanceof Error ? error.message : String(error) });
      });
    },

    DeleteSession(
      call: grpc.ServerUnaryCall<DeleteSessionRequestProto, object>,
      callback: grpc.sendUnaryData<object>,
    ): void {
      const id = call.request.session_id || call.request.sessionId || '';
      if (!id) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: 'session_id is required' });
        return;
      }
      state.sessionStore.delete(id).then(() => {
        callback(null, {});
      }).catch((error: unknown) => {
        callback({ code: grpc.status.NOT_FOUND, message: error instanceof Error ? error.message : String(error) });
      });
    },

    SessionChat(call: grpc.ServerWritableStream<SessionChatRequestProto, object>): void {
      const sessionId = call.request.session_id || call.request.sessionId || '';
      const userMsg = call.request.message;

      if (!sessionId) {
        call.write({ error: { code: 'INVALID_ARGUMENT', message: 'session_id is required' } });
        call.end();
        return;
      }
      if (!userMsg || !userMsg.content) {
        call.write({ error: { code: 'INVALID_ARGUMENT', message: 'message with content is required' } });
        call.end();
        return;
      }

      const chatMessage = {
        role: toRole((userMsg.role ?? 'ROLE_USER') as string | number),
        content: userMsg.content || '',
        name: userMsg.name || undefined,
        tool_call_id: userMsg.tool_call_id || userMsg.toolCallId || undefined,
        tool_calls: userMsg.tool_calls || userMsg.toolCalls || undefined,
      };

      const opts = call.request.options || {};
      const requestParams: RequestParams = {};
      if (opts.temperature != null) requestParams.temperature = opts.temperature;
      if (opts.top_p != null) requestParams.top_p = opts.top_p;
      if (opts.top_k != null) requestParams.top_k = opts.top_k;
      if (opts.max_tokens != null) requestParams.maxTokens = opts.max_tokens;
      if (opts.timeout != null) requestParams.timeout = opts.timeout;
      const hasParams = Object.keys(requestParams).length > 0;

      const toolMode = opts.tool_mode || opts.toolMode || 'none';
      const maxToolIterations = opts.max_tool_iterations || opts.maxToolIterations || 10;

      (async () => {
        try {
          const session = await state.sessionStore.get(sessionId, true);
          await state.sessionStore.appendMessage(sessionId, chatMessage);

          const allMessages = [...session.messages, chatMessage];
          const toolOptions: ChatToolOptions = { toolMode, maxToolIterations };

          let fullText = '';
          const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

          for await (const chunk of state.chat(session.model, allMessages, hasParams ? requestParams : undefined, toolOptions)) {
            if (chunk.type === 'text' && chunk.text) {
              fullText += chunk.text;
              call.write({ text: { text: chunk.text } });
            } else if (chunk.type === 'tool') {
              if (chunk.done && chunk.call) {
                const callId = `call_${chunk.name}_${Date.now()}`;
                pendingToolCalls.push({
                  id: callId,
                  name: chunk.name || '',
                  arguments: chunk.call.params ? JSON.stringify(chunk.call.params) : '{}',
                });

                // Persist assistant tool_calls message + tool result
                await state.sessionStore.appendMessage(sessionId, {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ id: callId, type: 'function', function: { name: chunk.name, arguments: chunk.call.params ? JSON.stringify(chunk.call.params) : '{}' } }],
                });
                await state.sessionStore.appendMessage(sessionId, {
                  role: 'tool',
                  content: typeof chunk.call.result === 'string' ? chunk.call.result : JSON.stringify(chunk.call.result || {}),
                  tool_call_id: callId,
                });
              }
            } else if (chunk.type === 'error') {
              call.write({ error: { code: 'INTERNAL', message: chunk.error } });
            } else if (chunk.type === 'done') {
              call.write({ done: { finish_reason: chunk.finishReason || 'stop' } });
            }
          }

          if (fullText) {
            await state.sessionStore.appendMessage(sessionId, { role: 'assistant', content: fullText });
          }

          // Auto-title on first turn
          if (session.messages.length === 0 && session.title === 'New Session') {
            const title = chatMessage.content.substring(0, 60).replace(/\n/g, ' ').trim();
            if (title) {
              await state.sessionStore.updateTitle(sessionId, title);
            }
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('[gRPC] SessionChat error:', msg);
          call.write({ error: { code: 'INTERNAL', message: msg } });
        } finally {
          call.end();
        }
      })();
    },
    WatchSessions(call: grpc.ServerWritableStream<object, object>): void {
      call.end();
    },
    ReplaySession(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
    },
    SummarizeSession(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
    },
    ForkSession(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
    },
    ExportSession(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
    },
    ImportSession(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
    },
    
    /**
     * List all policies (built-in + custom)
     */
    ListPolicies(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      try {
        const policies = listAllPolicies();
        callback(null, {
          policies: policies.map(p => ({
            name: p.name,
            builtin: p.builtin,
            config: policyToProto(p.config),
          })),
        });
      } catch (error: unknown) {
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /**
     * Tool RPCs (stub - future MCP integration)
     */
    ListTools(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback(null, { tools: [] });
    },
    ExecuteTool(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Tool execution not yet implemented' });
    },
    
    /**
     * MCP Server Registration (stub)
     */
    RegisterMcpServer(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback(null, {});
    },
    UnregisterMcpServer(call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>): void {
      callback(null, {});
    },
  };
}

function toTimestamp(iso: string): { seconds: string; nanos: number } {
  const ms = new Date(iso).getTime();
  return { seconds: String(Math.floor(ms / 1000)), nanos: 0 };
}

function sessionToProto(session: import('../../core/session-store.js').Session) {
  return {
    id: session.id,
    model: session.model,
    topic: session.title,
    messages: session.messages.map((m) => ({
      role: m.role === 'system' ? 0 : m.role === 'user' ? 1 : m.role === 'assistant' ? 2 : m.role === 'tool' ? 3 : 1,
      content: m.content,
      name: m.name,
      tool_call_id: m.tool_call_id,
      tool_calls: m.tool_calls,
    })),
    metadata: session.metadata,
    created_at: toTimestamp(session.createdAt),
    updated_at: toTimestamp(session.updatedAt),
    forked_from: session.parentSessionId,
    fork_point: session.forkPoint,
  };
}

function summaryToProto(summary: import('../../core/session-store.js').SessionSummary) {
  return {
    id: summary.id,
    model: summary.model,
    topic: summary.title,
    message_count: summary.messageCount,
    created_at: toTimestamp(summary.createdAt),
    updated_at: toTimestamp(summary.updatedAt),
  };
}

function policyToProto(cfg: PolicyCfg): PolicyProtoOutput {
  return {
    sampling: cfg.sampling ? {
      temperature: cfg.sampling.temperature,
      top_p: cfg.sampling.top_p,
      top_k: cfg.sampling.top_k,
    } : undefined,
    output: cfg.output ? {
      max_tokens: cfg.output.max_tokens,
      reserved_output_tokens: cfg.output.reserved_output_tokens,
      format: cfg.output.format,
      system_prompt_snippet: cfg.output.system_prompt_snippet,
      system_prompt_mode: cfg.output.system_prompt_mode,
    } : undefined,
    context: cfg.context ? {
      context_threshold: cfg.context.context_threshold,
      compression_strategy: cfg.context.compression_strategy,
    } : undefined,
    tool: cfg.tool ? {
      max_tool_iterations: cfg.tool.max_tool_iterations,
      tool_mode: cfg.tool.tool_mode,
    } : undefined,
    reliability: cfg.reliability ? {
      retry_on_invalid_json: cfg.reliability.retry_on_invalid_json,
      timeout: cfg.reliability.timeout,
    } : undefined,
  };
}
