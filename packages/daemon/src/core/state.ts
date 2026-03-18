/**
 * CoreState — the reusable library core of Abbenay.
 *
 * Contains pure provider/model logic with zero transport awareness.
 * SecretStore is injected, ToolExecutor is injectable per-call.
 *
 * This class is the public API surface for @abbenay/core consumers
 * (agent devs, web devs, custom apps).
 */

import type { SecretStore } from './secrets.js';
import { debug } from './debug.js';
import {
  loadConfig,
  loadWorkspaceConfig,
  mergeConfigs,
  mergeMultipleWorkspaceConfigs,
  resolveEngineModelId,
  type ConfigFile,
  type ProviderConfig,
  type ModelConfig,
} from './config.js';
import { resolvePolicy, flattenPolicy, type FlattenedPolicy, type PolicyConfig } from './policies.js';
import {
  getEngines,
  getEngine,
  fetchModels,
  streamChat,
  type ChatMessage,
  type EngineInfo,
  type ChatParams,
  type ChatChunk,
  type DiscoveredModel,
  type ToolDefinition,
  type ToolExecutor,
  type ToolValidationCallback,
} from './engines.js';
import { matchesAnyPattern, type ToolRegistry } from './tool-registry.js';
import { VERSION } from '../version.js';

// ── Virtual provider info (runtime, for API responses) ─────────────────

/**
 * Virtual provider — user-created instance pointing to an engine.
 * The unique ID is `id` (= the config YAML key = virtual provider name).
 */
export interface ProviderInfo {
  /** Virtual provider name = unique ID (e.g., "work-openrouter") */
  id: string;
  /** Actual engine type (e.g., "openrouter") */
  engine: string;
  /** Whether this provider has been configured with required credentials */
  configured: boolean;
  /** Whether the provider is reachable (from health checks) */
  healthy: boolean;
  /** Whether the underlying engine requires an API key */
  requiresKey: boolean;
  /** Engine's default base URL */
  defaultBaseUrl?: string;
  /** Configured base URL override */
  baseUrl?: string;
}

// ── Virtual model info (runtime, for API responses) ────────────────────

/**
 * Virtual model — user's configured entry for an engine model.
 * The unique ID is `id` = "{provider-id}/{model-name}".
 */
export interface ModelInfo {
  /** Composite unique ID: "{provider-id}/{model-name}" */
  id: string;
  /** Virtual model name = unique ID within provider (the config key) */
  name: string;
  /** Actual engine model ID sent to the API (from model_id field or = name) */
  engineModelId: string;
  /** Virtual provider ID (back-reference) */
  provider: string;
  /** Actual engine type (convenience, from provider) */
  engine: string;
  /** Context window size */
  contextWindow: number;
  /** Model capabilities */
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
  /** Per-model parameter overrides from config */
  params?: ModelConfig;
}

// ── Chat tool options ──────────────────────────────────────────────────

/**
 * Chat options controlling tool behavior.
 */
export interface ChatToolOptions {
  /** "auto" (default) | "passthrough" | "none" */
  toolMode?: string;
  /** Client-provided tool definitions (overrides registry when present) */
  tools?: ToolDefinition[];
  /** Max tool execution rounds (0 = unlimited, default 10) */
  maxToolIterations?: number;
  /** Only expose these tools to the LLM (empty = all). Matches namespaced names. */
  toolFilter?: string[];
  /** Session ID for session-scoped tool visibility */
  sessionId?: string;
  /**
   * Called when a tool matches `require_approval` patterns and needs user confirmation.
   * The implementation is transport-specific: the web server writes an SSE event and
   * blocks until the user responds; the CLI prompts via readline.
   * Return 'allow' to proceed, 'deny' to skip this call, 'abort' to stop all tools.
   */
  onToolApprovalNeeded?: (requestId: string, toolName: string, args: unknown, namespacedName?: string) => Promise<'allow' | 'deny' | 'abort'>;
}

// ── Builder options ─────────────────────────────────────────────────────

/**
 * Options for adding a provider programmatically.
 * This is the ergonomic API — consumers don't need to understand the YAML schema.
 */
export interface AddProviderOptions {
  /** Engine type: "openai", "anthropic", "ollama", etc. */
  engine: string;
  /** API key value — stored in the SecretStore automatically */
  apiKey?: string;
  /** Custom base URL (overrides engine default) */
  baseUrl?: string;
  /** Environment variable name for API key (alternative to apiKey) */
  apiKeyEnvVar?: string;
  /** Models to enable: key = model name, value = config (or {} for defaults) */
  models?: Record<string, ModelConfig>;
}

// ── CoreState ──────────────────────────────────────────────────────────

export interface CoreStateOptions {
  /** Injected secret store (e.g., MemorySecretStore, KeychainSecretStore) */
  secretStore: SecretStore;
  /** Optional config loader override (defaults to loadConfig()) */
  configLoader?: () => ConfigFile;
}

/**
 * Core daemon state — pure provider/model logic, no transport.
 */
export class CoreState {
  public readonly version = VERSION;
  public readonly startedAt = new Date();

  /** Injected secret store */
  public readonly secretStore: SecretStore;

  /** Optional config loader override */
  private configLoader?: () => ConfigFile;

  /** In-memory providers added via addProvider() — merged over disk config */
  private inMemoryProviders = new Map<string, ProviderConfig>();

  /** Health status per virtual provider (lazy, updated in background) */
  protected providerHealth = new Map<string, boolean>();

  /**
   * Optional tool registry for automatic tool aggregation.
   *
   * When set, chat() in 'auto' mode uses the registry's tools and executor
   * automatically (unless the caller provides explicit tools in ChatToolOptions).
   *
   * Library consumers set this to collect tools from their own sources.
   * The daemon sets this and wires in a fallback executor for VS Code / MCP routing.
   */
  public toolRegistry?: ToolRegistry;

  constructor(options: CoreStateOptions) {
    this.secretStore = options.secretStore;
    this.configLoader = options.configLoader;
  }

  // ─── Builder API ────────────────────────────────────────────────────

  /**
   * Add a provider programmatically (in-memory, no disk writes).
   *
   * If `apiKey` is provided, it is stored in the injected SecretStore
   * automatically. The provider is immediately available for chat/listing.
   *
   * @example
   * ```typescript
   * await core.addProvider('my-openai', {
   *   engine: 'openai',
   *   apiKey: 'sk-...',
   *   models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.3 } },
   * });
   * ```
   */
  async addProvider(providerId: string, options: AddProviderOptions): Promise<void> {
    const engineInfo = getEngine(options.engine);
    if (!engineInfo) {
      throw new Error(`Unknown engine: "${options.engine}". Use listEngines() to see available engines.`);
    }

    const providerCfg: ProviderConfig = {
      engine: options.engine,
      models: options.models || {},
    };

    if (options.baseUrl) {
      providerCfg.base_url = options.baseUrl;
    }

    // Store API key in SecretStore if provided
    if (options.apiKey) {
      const keychainName = `abbenay.${providerId}`;
      await this.secretStore.set(keychainName, options.apiKey);
      providerCfg.api_key_keychain_name = keychainName;
    } else if (options.apiKeyEnvVar) {
      providerCfg.api_key_env_var_name = options.apiKeyEnvVar;
    }

    this.inMemoryProviders.set(providerId, providerCfg);
  }

  /**
   * Remove a provider (in-memory only — does not modify disk config).
   * Returns true if the provider existed, false otherwise.
   */
  removeProvider(providerId: string): boolean {
    this.providerHealth.delete(providerId);
    return this.inMemoryProviders.delete(providerId);
  }

  /**
   * Add or update a model on an existing provider.
   * Works on both in-memory and disk-loaded providers.
   *
   * @example
   * ```typescript
   * core.addModel('my-openai', 'gpt-4o-mini', { temperature: 0.3 });
   * ```
   */
  addModel(providerId: string, modelName: string, modelConfig: ModelConfig = {}): void {
    // Check in-memory first
    const memProvider = this.inMemoryProviders.get(providerId);
    if (memProvider) {
      if (!memProvider.models) memProvider.models = {};
      memProvider.models[modelName] = modelConfig;
      return;
    }

    // If provider exists in disk config, promote it to in-memory so we can mutate
    const diskConfig = this.loadProviderConfig();
    const diskProvider = diskConfig[providerId];
    if (!diskProvider) {
      throw new Error(`Provider "${providerId}" not found. Use addProvider() first.`);
    }

    // Clone disk provider into in-memory so mutations don't affect the original
    const cloned: ProviderConfig = { ...diskProvider, models: { ...diskProvider.models } };
    cloned.models![modelName] = modelConfig;
    this.inMemoryProviders.set(providerId, cloned);
  }

  /**
   * Remove a model from a provider.
   * Returns true if the model existed, false otherwise.
   */
  removeModel(providerId: string, modelName: string): boolean {
    // Check in-memory first
    const memProvider = this.inMemoryProviders.get(providerId);
    if (memProvider?.models) {
      const existed = modelName in memProvider.models;
      delete memProvider.models[modelName];
      return existed;
    }

    // If provider exists in disk config, promote to in-memory to mutate
    const diskConfig = this.loadProviderConfig();
    const diskProvider = diskConfig[providerId];
    if (!diskProvider?.models || !(modelName in diskProvider.models)) {
      return false;
    }

    const cloned: ProviderConfig = { ...diskProvider, models: { ...diskProvider.models } };
    delete cloned.models![modelName];
    this.inMemoryProviders.set(providerId, cloned);
    return true;
  }

  /**
   * Check whether a provider exists (in-memory or disk config).
   */
  hasProvider(providerId: string): boolean {
    if (this.inMemoryProviders.has(providerId)) return true;
    const diskConfig = this.configLoader ? this.configLoader() : loadConfig();
    return !!(diskConfig.providers && providerId in diskConfig.providers);
  }

  // ─── Config ──────────────────────────────────────────────────────────

  /**
   * Load provider config, merging disk config with in-memory providers.
   * In-memory providers take precedence over disk config for the same ID.
   */
  loadProviderConfig(workspacePath?: string): Record<string, ProviderConfig> {
    const userConfig = this.configLoader ? this.configLoader() : loadConfig();
    const wsConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
    const merged = mergeConfigs(userConfig, wsConfig);
    const diskProviders = merged.providers || {};

    // Merge in-memory providers over disk providers
    if (this.inMemoryProviders.size === 0) {
      return diskProviders;
    }

    const result = { ...diskProviders };
    for (const [id, cfg] of this.inMemoryProviders) {
      result[id] = cfg;
    }
    return result;
  }

  /**
   * Resolve the API key for a virtual provider from config (keychain or env var).
   * Falls back to the engine's default env var if no explicit config.
   */
  async resolveApiKey(providerId: string, providerCfg?: ProviderConfig): Promise<string | null> {
    if (!providerCfg) {
      const config = this.loadProviderConfig();
      providerCfg = config[providerId];
    }

    if (!providerCfg) return null;

    // Check keychain
    if (providerCfg.api_key_keychain_name) {
      const value = await this.secretStore.get(providerCfg.api_key_keychain_name);
      if (value) return value;
    }

    // Check env var from config
    if (providerCfg.api_key_env_var_name) {
      const value = process.env[providerCfg.api_key_env_var_name];
      if (value && value.length > 0) return value;
    }

    // Fall back to engine's default env var
    const engineInfo = getEngine(providerCfg.engine);
    if (engineInfo?.defaultEnvVar) {
      const value = process.env[engineInfo.defaultEnvVar];
      if (value && value.length > 0) return value;
    }

    return null;
  }

  /**
   * Resolve API key and base URL for an existing provider from config.
   * Used by the edit wizard to discover models without re-entering credentials.
   */
  async resolveProviderCredentials(providerId: string): Promise<{ apiKey?: string; baseUrl?: string }> {
    const config = this.loadProviderConfig();
    const provCfg = config[providerId];
    if (!provCfg) return {};

    const apiKey = await this.resolveApiKey(providerId, provCfg);
    return {
      apiKey: apiKey || undefined,
      baseUrl: provCfg.base_url || undefined,
    };
  }

  // ─── Providers (virtual layer) ───────────────────────────────────────

  /**
   * List all virtual providers with configuration status.
   * Returns only providers that exist in the config (user-created instances).
   */
  async listProviders(workspacePaths: string[] = []): Promise<ProviderInfo[]> {
    const config = workspacePaths.length > 0
      ? (mergeMultipleWorkspaceConfigs(workspacePaths).providers || {})
      : this.loadProviderConfig();

    const providers: ProviderInfo[] = [];

    for (const [providerId, providerCfg] of Object.entries(config)) {
      const engineInfo = getEngine(providerCfg.engine);
      if (!engineInfo) {
        console.warn(`[State] Unknown engine "${providerCfg.engine}" for provider "${providerId}", skipping`);
        continue;
      }

      let configured = false;
      if (!engineInfo.requiresKey) {
        configured = true;
      } else {
        const key = await this.resolveApiKey(providerId, providerCfg);
        configured = key !== null;
      }

      providers.push({
        id: providerId,
        engine: providerCfg.engine,
        configured,
        healthy: this.providerHealth.get(providerId) ?? true,
        requiresKey: engineInfo.requiresKey,
        defaultBaseUrl: engineInfo.defaultBaseUrl,
        baseUrl: providerCfg.base_url,
      });
    }

    return providers;
  }

  /**
   * List engines available for the "Add Provider" wizard.
   * Returns the fixed set of engine types from engines.ts.
   */
  listEngines(): EngineInfo[] {
    return getEngines();
  }

  // ─── Models (virtual layer) ──────────────────────────────────────────

  /**
   * List all virtual models across all configured providers.
   */
  async listModels(workspacePaths: string[] = []): Promise<ModelInfo[]> {
    const config = workspacePaths.length > 0
      ? (mergeMultipleWorkspaceConfigs(workspacePaths).providers || {})
      : this.loadProviderConfig();

    const allModels: ModelInfo[] = [];

    for (const [providerId, providerCfg] of Object.entries(config)) {
      const engineInfo = getEngine(providerCfg.engine);
      if (!engineInfo) continue;

      if (!providerCfg.models || Object.keys(providerCfg.models).length === 0) {
        continue;
      }

      const apiKey = await this.resolveApiKey(providerId, providerCfg);
      if (engineInfo.requiresKey && !apiKey) {
        continue;
      }

      let discoveredModels: DiscoveredModel[] = [];
      try {
        discoveredModels = await fetchModels(providerCfg.engine, apiKey || undefined, providerCfg.base_url);
      } catch (error) {
        console.error(`[State] Failed to fetch models for provider ${providerId}:`, error);
      }

      const discoveryMap = new Map<string, DiscoveredModel>();
      for (const dm of discoveredModels) {
        discoveryMap.set(dm.id, dm);
      }

      for (const [modelName, modelCfg] of Object.entries(providerCfg.models)) {
        const engineModelId = resolveEngineModelId(modelName, modelCfg);
        const compositeId = `${providerId}/${modelName}`;
        const discovered = discoveryMap.get(engineModelId);

        allModels.push({
          id: compositeId,
          name: modelName,
          engineModelId,
          provider: providerId,
          engine: providerCfg.engine,
          contextWindow: discovered?.contextWindow || 0,
          capabilities: discovered?.capabilities,
          params: Object.keys(modelCfg).length > 0 ? modelCfg : undefined,
        });
      }
    }

    return allModels;
  }

  /**
   * Discover all models an engine offers, independent of config.
   */
  async discoverModels(engineId: string, apiKey?: string, baseUrl?: string): Promise<DiscoveredModel[]> {
    const engineInfo = getEngine(engineId);
    if (!engineInfo) return [];

    if (engineInfo.requiresKey && !apiKey) {
      return [];
    }

    try {
      return await fetchModels(engineId, apiKey || undefined, baseUrl);
    } catch (error) {
      console.error(`[State] Failed to discover models for engine ${engineId}:`, error);
      return [];
    }
  }

  // ─── Chat (virtual → actual resolution) ──────────────────────────────

  /**
   * Stream a chat response for a virtual model.
   *
   * Resolves the composite model ID to engine, API key, base URL, model config.
   * Applies system prompt and merges params (request > config > engine default).
   *
   * ToolExecutor is injectable per-call. CoreState does NOT default to any
   * transport-specific executor — that's the daemon's job.
   */
  async* chat(
    compositeModelId: string,
    messages: ChatMessage[],
    requestParams?: ChatParams,
    toolOptions?: ChatToolOptions,
    toolExecutor?: ToolExecutor,
    inlinePolicy?: PolicyConfig,
  ): AsyncGenerator<ChatChunk> {
    const toolMode = toolOptions?.toolMode || 'auto';
    debug(`[State] Chat request: compositeModelId="${compositeModelId}", messages=${messages.length}, toolMode="${toolMode}", tools=${toolOptions?.tools?.length || 0}`);

    // ── Validate passthrough mode ──
    if (toolMode === 'passthrough' && (!toolOptions?.tools || toolOptions.tools.length === 0)) {
      console.error(`[State] passthrough mode requires client-provided tools`);
      yield { type: 'error', error: 'passthrough mode requires client-provided tools' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // ── Split composite ID ──
    const slashIdx = compositeModelId.indexOf('/');
    if (slashIdx === -1) {
      console.error(`[State] Invalid composite model ID (no slash): ${compositeModelId}`);
      yield { type: 'error', error: `Invalid model ID (expected provider/model): ${compositeModelId}` };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    const providerId = compositeModelId.substring(0, slashIdx);
    const modelName = compositeModelId.substring(slashIdx + 1);
    debug(`[State] Chat: providerId="${providerId}", modelName="${modelName}"`);

    // ── Look up virtual provider ──
    const config = this.loadProviderConfig();
    const providerCfg = config[providerId];
    if (!providerCfg) {
      console.error(`[State] Provider not found: ${providerId}`);
      yield { type: 'error', error: `Provider not found: "${providerId}". Check your configuration.` };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    const engineInfo = getEngine(providerCfg.engine);
    if (!engineInfo) {
      console.error(`[State] Unknown engine "${providerCfg.engine}" for provider "${providerId}"`);
      yield { type: 'error', error: `Unknown engine "${providerCfg.engine}" for provider "${providerId}"` };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // ── Resolve API key ──
    const apiKey = await this.resolveApiKey(providerId, providerCfg);
    if (engineInfo.requiresKey && !apiKey) {
      console.error(`[State] No API key for provider ${providerId}`);
      yield { type: 'error', error: `No API key configured for provider "${providerId}". Add one via the Web UI or config file.` };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // ── Look up virtual model ──
    const modelCfg = providerCfg.models?.[modelName];
    const engineModelId = modelCfg
      ? resolveEngineModelId(modelName, modelCfg)
      : modelName;

    // ── Resolve policy (runtime-only, never persisted) ──
    // Inline policy fully replaces the named policy (see DR-023).
    let flatPolicy: FlattenedPolicy | undefined;
    if (inlinePolicy) {
      flatPolicy = flattenPolicy(inlinePolicy);
    } else if (modelCfg?.policy) {
      flatPolicy = resolveFlatPolicy(modelCfg.policy);
    }

    // Policy can override tool mode (caller's explicit value takes priority)
    const effectiveToolMode = toolOptions?.toolMode || flatPolicy?.toolMode || 'auto';

    // ── Apply system prompt (policy snippet + model prompt) ──
    let processedMessages = [...messages];
    const combinedSystemPrompt = combineSystemPrompts(flatPolicy, modelCfg);
    if (combinedSystemPrompt) {
      const mode = modelCfg?.system_prompt_mode || 'prepend';
      processedMessages = applySystemPrompt(processedMessages, combinedSystemPrompt, mode);
    }

    // ── Merge params (4-tier: request > config > policy > engine default) ──
    const mergedParams = mergeParams(modelCfg, requestParams, flatPolicy);

    debug(`[State] Chat: engine="${providerCfg.engine}", engineModelId="${engineModelId}", toolMode="${effectiveToolMode}", baseUrl="${providerCfg.base_url || '(none)'}"`);

    // ── Resolve tools based on mode ──
    let tools: ToolDefinition[] | undefined;
    let resolvedExecutor: ToolExecutor | undefined;

    let toolPolicy: import('./tool-registry.js').ToolPolicyConfig | undefined;

    if (effectiveToolMode === 'none') {
      tools = undefined;
      resolvedExecutor = undefined;
    } else if (effectiveToolMode === 'passthrough') {
      tools = undefined;
      resolvedExecutor = undefined;
      console.warn(`[State] passthrough mode: tools will be sent to LLM but not executed (delegated to caller)`);
    } else {
      // Auto mode: use client tools if provided, otherwise fall back to registry
      if (toolOptions?.tools && toolOptions.tools.length > 0) {
        tools = toolOptions.tools;
        resolvedExecutor = toolExecutor;
      } else if (this.toolRegistry && this.toolRegistry.size > 0) {
        const config = this.configLoader ? this.configLoader() : loadConfig();
        toolPolicy = config.tool_policy;
        tools = this.toolRegistry.listForChat(toolPolicy, toolOptions?.sessionId);

        // Apply per-request tool_filter: restrict to only the listed tools
        if (toolOptions?.toolFilter && toolOptions.toolFilter.length > 0) {
          const filterSet = new Set(toolOptions.toolFilter);
          tools = tools.filter(t => filterSet.has(t.name));
        }

        resolvedExecutor = this.toolRegistry.buildExecutor(
          toolExecutor ? (tool, args) => toolExecutor!(tool.originalName, args) : undefined,
        );
        debug(`[State] Auto-loaded ${tools.length} tools from registry`);
      }
    }

    // ── Build tool validator from policy + caller's approval callback ──
    // Secure-by-default: all tools require approval unless explicitly
    // listed in auto_approve.  See DR-019.
    // Precedence: require_approval > auto_approve > default (ask).
    let toolValidator: ToolValidationCallback | undefined;
    if (toolOptions?.onToolApprovalNeeded && this.toolRegistry) {
      const registry = this.toolRegistry;
      const requirePatterns = toolPolicy?.require_approval;
      const autoPatterns = toolPolicy?.auto_approve;

      toolValidator = async (toolName: string, args: unknown): Promise<'allow' | 'deny' | 'abort'> => {
        const resolved = registry.resolve(toolName);
        const nsName = resolved?.namespacedName || toolName;

        if (matchesAnyPattern(requirePatterns, nsName)) {
          const requestId = crypto.randomUUID();
          debug(`[State] Tool "${toolName}" (${nsName}) requires approval (explicit) — requestId=${requestId}`);
          return toolOptions.onToolApprovalNeeded!(requestId, toolName, args, nsName);
        }

        if (matchesAnyPattern(autoPatterns, nsName)) {
          return 'allow';
        }

        const requestId = crypto.randomUUID();
        debug(`[State] Tool "${toolName}" (${nsName}) requires approval (default) — requestId=${requestId}`);
        return toolOptions.onToolApprovalNeeded!(requestId, toolName, args, nsName);
      };
    }

    // ── Resolve maxSteps for tool loop ──
    // Priority: caller > config tool_policy > policy tool.max_tool_iterations > default
    const maxSteps = toolOptions?.maxToolIterations
      ?? toolPolicy?.max_tool_iterations
      ?? flatPolicy?.maxToolIterations
      ?? 10;

    // ── Call the actual engine ──
    const isJsonStrict = flatPolicy?.outputFormat === 'json_only';
    const shouldRetryJson = isJsonStrict && flatPolicy?.retryOnInvalidJson;

    if (isJsonStrict && !shouldRetryJson) {
      yield* streamChat(
        providerCfg.engine, engineModelId, processedMessages,
        apiKey || undefined, providerCfg.base_url, mergedParams,
        tools, resolvedExecutor, toolValidator, maxSteps,
      );
    } else if (shouldRetryJson) {
      yield* streamChatWithJsonRetry(
        providerCfg.engine, engineModelId, processedMessages,
        apiKey || undefined, providerCfg.base_url, mergedParams,
        tools, resolvedExecutor, toolValidator, maxSteps,
      );
    } else {
      yield* streamChat(
        providerCfg.engine, engineModelId, processedMessages,
        apiKey || undefined, providerCfg.base_url, mergedParams,
        tools, resolvedExecutor, toolValidator, maxSteps,
      );
    }
  }

  // ─── Health checks ───────────────────────────────────────────────────

  /**
   * Run background health checks for all configured providers.
   */
  async runHealthChecks(): Promise<void> {
    const config = this.loadProviderConfig();

    for (const [providerId, providerCfg] of Object.entries(config)) {
      const engineInfo = getEngine(providerCfg.engine);
      if (!engineInfo) {
        this.providerHealth.set(providerId, false);
        continue;
      }

      try {
        const apiKey = await this.resolveApiKey(providerId, providerCfg);
        if (engineInfo.requiresKey && !apiKey) {
          this.providerHealth.set(providerId, false);
          continue;
        }

        const models = await fetchModels(providerCfg.engine, apiKey || undefined, providerCfg.base_url);
        this.providerHealth.set(providerId, models.length > 0);
      } catch {
        this.providerHealth.set(providerId, false);
      }
    }
  }
}

// ── Helper functions (module-level) ────────────────────────────────────

/**
 * Apply system prompt to message thread.
 * - prepend: system prompt goes before existing system message content
 * - replace: system prompt replaces all existing system messages
 */
function applySystemPrompt(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  mode: 'prepend' | 'replace',
): Array<{ role: string; content: string }> {
  if (mode === 'replace') {
    const filtered = messages.filter(m => m.role !== 'system');
    return [{ role: 'system', content: systemPrompt }, ...filtered];
  }

  const firstSystemIdx = messages.findIndex(m => m.role === 'system');
  if (firstSystemIdx >= 0) {
    const result = [...messages];
    result[firstSystemIdx] = {
      ...result[firstSystemIdx],
      content: `${systemPrompt}\n\n${result[firstSystemIdx].content}`,
    };
    return result;
  }

  return [{ role: 'system', content: systemPrompt }, ...messages];
}

/**
 * Resolve a policy name to its flattened representation.
 * Returns undefined if the policy doesn't exist.
 */
function resolveFlatPolicy(policyName: string): FlattenedPolicy | undefined {
  const policy = resolvePolicy(policyName);
  if (!policy) return undefined;
  return flattenPolicy(policy);
}

/**
 * Combine the policy's system_prompt_snippet with the model's system_prompt.
 * Returns the final system prompt string, or undefined if neither exists.
 *
 * Policy system_prompt_mode controls how snippet combines with model prompt:
 *   prepend (default): [snippet]\n\n[model prompt]
 *   append:            [model prompt]\n\n[snippet]
 *   replace:           [snippet] (model prompt ignored)
 */
function combineSystemPrompts(
  flatPolicy: FlattenedPolicy | undefined,
  modelCfg: ModelConfig | undefined,
): string | undefined {
  const snippet = flatPolicy?.systemPromptSnippet;
  const modelPrompt = modelCfg?.system_prompt;

  if (!snippet && !modelPrompt) return undefined;
  if (!snippet) return modelPrompt;
  if (!modelPrompt) return snippet;

  const mode = flatPolicy?.systemPromptMode || 'prepend';
  switch (mode) {
    case 'replace': return snippet;
    case 'append':  return `${modelPrompt}\n\n${snippet}`;
    case 'prepend':
    default:        return `${snippet}\n\n${modelPrompt}`;
  }
}

/**
 * Merge chat params: request > config > policy > engine default.
 * Policy provides the base, config overrides it, request overrides everything.
 */
function mergeParams(
  configParams?: ModelConfig,
  requestParams?: ChatParams,
  flatPolicy?: FlattenedPolicy,
): ChatParams | undefined {
  const merged: ChatParams = {};
  let hasAny = false;

  // Layer 1: Policy defaults
  const pp = flatPolicy?.params;
  if (pp?.temperature != null) { merged.temperature = pp.temperature; hasAny = true; }
  if (pp?.top_p != null) { merged.top_p = pp.top_p; hasAny = true; }
  if (pp?.top_k != null) { merged.top_k = pp.top_k; hasAny = true; }
  if (pp?.max_tokens != null) { merged.maxTokens = pp.max_tokens; hasAny = true; }
  if (pp?.timeout != null) { merged.timeout = pp.timeout; hasAny = true; }

  // Layer 2: Explicit model config (overrides policy)
  if (configParams?.temperature != null) { merged.temperature = configParams.temperature; hasAny = true; }
  if (configParams?.top_p != null) { merged.top_p = configParams.top_p; hasAny = true; }
  if (configParams?.top_k != null) { merged.top_k = configParams.top_k; hasAny = true; }
  if (configParams?.max_tokens != null) { merged.maxTokens = configParams.max_tokens; hasAny = true; }
  if (configParams?.timeout != null) { merged.timeout = configParams.timeout; hasAny = true; }

  // Layer 3: Per-request params (overrides everything)
  if (requestParams?.temperature != null) { merged.temperature = requestParams.temperature; hasAny = true; }
  if (requestParams?.top_p != null) { merged.top_p = requestParams.top_p; hasAny = true; }
  if (requestParams?.top_k != null) { merged.top_k = requestParams.top_k; hasAny = true; }
  if (requestParams?.maxTokens != null) { merged.maxTokens = requestParams.maxTokens; hasAny = true; }
  if (requestParams?.timeout != null) { merged.timeout = requestParams.timeout; hasAny = true; }

  return hasAny ? merged : undefined;
}

/**
 * Stream chat with JSON validation and retry.
 * Buffers the full response, attempts JSON.parse(), and retries once on failure.
 */
async function* streamChatWithJsonRetry(
  engine: string,
  engineModelId: string,
  messages: ChatMessage[],
  apiKey: string | undefined,
  baseUrl: string | undefined,
  params: ChatParams | undefined,
  tools: ToolDefinition[] | undefined,
  toolExecutor: ToolExecutor | undefined,
  toolValidator: ToolValidationCallback | undefined,
  maxSteps: number,
): AsyncGenerator<ChatChunk> {
  let fullText = '';
  const buffered: ChatChunk[] = [];

  for await (const chunk of streamChat(engine, engineModelId, messages, apiKey, baseUrl, params, tools, toolExecutor, toolValidator, maxSteps)) {
    buffered.push(chunk);
    if (chunk.type === 'text') {
      fullText += chunk.text;
    }
  }

  try {
    JSON.parse(fullText.trim());
    for (const chunk of buffered) {
      yield chunk;
    }
    return;
  } catch {
    console.warn(`[State] json_strict: response is not valid JSON (${fullText.length} chars). Retrying once.`);
  }

  const retryMessages = [
    ...messages,
    { role: 'assistant', content: fullText },
    { role: 'user', content: 'Your previous response was not valid JSON. Respond with ONLY valid JSON. Fix the output — no explanation, no markdown fences, just the JSON.' },
  ];

  yield* streamChat(engine, engineModelId, retryMessages, apiKey, baseUrl, params, tools, toolExecutor, toolValidator, maxSteps);
}
