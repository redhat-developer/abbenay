/**
 * Provider adapter - wraps Vercel AI SDK providers for Abbenay
 *
 * The "actual" layer: engines are fixed API implementations from the Vercel AI SDK.
 * Virtual providers (user-defined instances) live in config/state -- not here.
 *
 * This module uses a data-driven provider registry: adding a new engine is as
 * simple as adding an entry to the ENGINES record. Each entry carries metadata
 * AND the factory function, so no switch statements are needed at runtime.
 *
 * Tool support uses Vercel AI SDK's native tool() objects and streamText() with
 * the built-in step loop (stopWhen). No wrapper classes required.
 */

import { streamText, jsonSchema, tool } from 'ai';
import type { AssistantModelMessage, JSONSchema7, LanguageModel, ModelMessage, ToolSet } from 'ai';

import { mockStreamChat, getMockModels } from './mock.js';
import { debug } from './debug.js';

// ── Provider config type for factory functions ─────────────────────────

interface ProviderFactoryConfig {
  apiKey?: string;
  baseURL?: string;
}

// ── Engine metadata (actual layer) ─────────────────────────────────────

/**
 * Engine = actual API implementation backed by a Vercel AI SDK provider.
 * Fixed set, not user-configurable. This is the "actual" layer.
 *
 * Adding a new engine requires only a new entry here -- no other code changes.
 */
export interface EngineInfo {
  /** Engine type identifier (e.g., "openrouter", "openai") */
  id: string;
  /** Whether this engine requires an API key */
  requiresKey: boolean;
  /** Default base URL (undefined if user must set) */
  defaultBaseUrl?: string;
  /** Default environment variable for API key */
  defaultEnvVar?: string;
  /** Whether this engine supports tool calling */
  supportsTools: boolean;
  /** Factory: creates a Vercel AI SDK provider and returns a language model (async for dynamic loading) */
  createModel: (modelId: string, config: ProviderFactoryConfig) => Promise<LanguageModel>;
}

// ── Dynamic provider loading ────────────────────────────────────────────

/**
 * Dynamically import an @ai-sdk/* provider package.
 * This allows provider packages to be truly optional — only the engines
 * a consumer actually uses need to be installed.
 */
async function loadProviderFactory(packageName: string, exportName: string): Promise<unknown> {
  try {
    const mod = await import(packageName);
    const factory = mod[exportName];
    if (!factory) {
      throw new Error(`Package '${packageName}' does not export '${exportName}'`);
    }
    return factory;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `AI SDK provider package '${packageName}' is not installed. ` +
        `Install it with: npm install ${packageName}`
      );
    }
    throw err;
  }
}

type DedicatedProviderFactory = (config: Record<string, unknown>) => (modelId: string) => Promise<LanguageModel>;

/** Create model via a dedicated @ai-sdk/* provider package (dynamically loaded) */
async function dedicatedProvider(
  packageName: string,
  exportName: string,
  config: ProviderFactoryConfig,
  modelId: string,
): Promise<LanguageModel> {
  const factory = await loadProviderFactory(packageName, exportName) as DedicatedProviderFactory;
  const provider = factory({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  return provider(modelId);
}

type OpenAIChatProviderFactory = (config: Record<string, unknown>) => { chatModel: (modelId: string) => Promise<LanguageModel> };

/** Create model via @ai-sdk/openai-compatible (dynamically loaded) */
async function openaiCompatibleProvider(
  name: string,
  defaultBaseURL: string,
  config: ProviderFactoryConfig,
  modelId: string,
): Promise<LanguageModel> {
  const factory = await loadProviderFactory('@ai-sdk/openai-compatible', 'createOpenAICompatible') as OpenAIChatProviderFactory;
  const provider = factory({
    name,
    baseURL: config.baseURL || defaultBaseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
  return provider.chatModel(modelId);
}

// ── Engine registry ────────────────────────────────────────────────────

/**
 * Data-driven provider registry.
 * Each entry carries metadata AND the factory function.
 * Adding a new engine = adding a new entry. No switch/if-else anywhere.
 */
const ENGINES: Record<string, EngineInfo> = {
  // ── Mock (testing) ──────────────────────────────────────────────────
  mock: {
    id: 'mock',
    requiresKey: false,
    supportsTools: false,
    createModel: () => { throw new Error('Mock engine uses mockStreamChat, not createModel'); },
  },

  // ── Dedicated provider packages ─────────────────────────────────────
  openai: {
    id: 'openai',
    requiresKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultEnvVar: 'OPENAI_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/openai', 'createOpenAI', config, modelId),
  },
  anthropic: {
    id: 'anthropic',
    requiresKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultEnvVar: 'ANTHROPIC_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/anthropic', 'createAnthropic', config, modelId),
  },
  gemini: {
    id: 'gemini',
    requiresKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultEnvVar: 'GOOGLE_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/google', 'createGoogleGenerativeAI', config, modelId),
  },
  mistral: {
    id: 'mistral',
    requiresKey: true,
    defaultBaseUrl: 'https://api.mistral.ai',
    defaultEnvVar: 'MISTRAL_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/mistral', 'createMistral', config, modelId),
  },
  xai: {
    id: 'xai',
    requiresKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultEnvVar: 'XAI_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/xai', 'createXai', config, modelId),
  },
  deepseek: {
    id: 'deepseek',
    requiresKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultEnvVar: 'DEEPSEEK_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/deepseek', 'createDeepSeek', config, modelId),
  },
  groq: {
    id: 'groq',
    requiresKey: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultEnvVar: 'GROQ_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/groq', 'createGroq', config, modelId),
  },
  cohere: {
    id: 'cohere',
    requiresKey: true,
    defaultBaseUrl: 'https://api.cohere.com',
    defaultEnvVar: 'COHERE_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/cohere', 'createCohere', config, modelId),
  },
  bedrock: {
    id: 'bedrock',
    requiresKey: false, // Uses AWS credentials
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/amazon-bedrock', 'createAmazonBedrock', config, modelId),
  },
  fireworks: {
    id: 'fireworks',
    requiresKey: true,
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultEnvVar: 'FIREWORKS_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/fireworks', 'createFireworks', config, modelId),
  },
  togetherai: {
    id: 'togetherai',
    requiresKey: true,
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultEnvVar: 'TOGETHER_AI_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/togetherai', 'createTogetherAI', config, modelId),
  },
  perplexity: {
    id: 'perplexity',
    requiresKey: true,
    defaultBaseUrl: 'https://api.perplexity.ai',
    defaultEnvVar: 'PERPLEXITY_API_KEY',
    supportsTools: false,
    createModel: (modelId, config) => dedicatedProvider('@ai-sdk/perplexity', 'createPerplexity', config, modelId),
  },

  // ── Azure (uses OpenAI SDK with compatibility mode) ─────────────────
  azure: {
    id: 'azure',
    requiresKey: true,
    defaultEnvVar: 'AZURE_OPENAI_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('azure-openai', config.baseURL || '', config, modelId),
  },

  // ── OpenAI-compatible engines ───────────────────────────────────────
  openrouter: {
    id: 'openrouter',
    requiresKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultEnvVar: 'OPENROUTER_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('openrouter', 'https://openrouter.ai/api/v1', config, modelId),
  },
  ollama: {
    id: 'ollama',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('ollama', 'http://127.0.0.1:11434/v1', config, modelId),
  },
  lmstudio: {
    id: 'lmstudio',
    requiresKey: false,
    defaultBaseUrl: 'http://localhost:1234/v1',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('lmstudio', 'http://localhost:1234/v1', config, modelId),
  },
  cerebras: {
    id: 'cerebras',
    requiresKey: true,
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    defaultEnvVar: 'CEREBRAS_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('cerebras', 'https://api.cerebras.ai/v1', config, modelId),
  },
  meta: {
    id: 'meta',
    requiresKey: true,
    defaultBaseUrl: 'https://api.llama.com/compat/v1/',
    defaultEnvVar: 'META_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('meta', 'https://api.llama.com/compat/v1/', config, modelId),
  },
};

/** Index for O(1) lookup by engine ID */
const ENGINE_MAP = new Map<string, EngineInfo>(
  Object.values(ENGINES).map(e => [e.id, e]),
);

// ── Engine accessors ───────────────────────────────────────────────────

/** Get all available engines (the fixed set of API implementations). */
export function getEngines(): EngineInfo[] {
  return Object.values(ENGINES);
}

/** Get a single engine by ID, or undefined if not found. */
export function getEngine(engineId: string): EngineInfo | undefined {
  return ENGINE_MAP.get(engineId);
}

/** Get predefined templates for the "Add Provider" wizard. */
export function getProviderTemplates(): ProviderTemplate[] {
  return Object.values(ENGINES).map(e => ({
    engine: e.id,
    suggestedName: e.id,
    defaultBaseUrl: e.defaultBaseUrl,
    requiresKey: e.requiresKey,
  }));
}

/**
 * Predefined template for the "Add Provider" wizard.
 */
export interface ProviderTemplate {
  engine: string;
  suggestedName: string;
  defaultBaseUrl?: string;
  requiresKey: boolean;
}

// ── Chat parameters ────────────────────────────────────────────────────

/**
 * Per-model chat parameters that can be passed through to the AI SDK.
 * Used for the 3-tier merge: Request > Config > Engine Default.
 */
export interface ChatParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  maxTokens?: number;
  timeout?: number;
}

// ── Tool definitions (passed from proto/config to AI SDK tools) ────────

/**
 * Tool definition as provided by callers (proto Tool or config).
 * Converted to Vercel AI SDK tool() objects.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: string;  // JSON schema string
}

/**
 * Callback provided by the caller to execute a tool.
 * The adapter delegates tool execution to this callback;
 * Vercel AI SDK handles the orchestration loop.
 */
export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Callback for tool execution validation (approval tiers).
 * Called BEFORE each tool execution.
 * Return 'allow' to proceed, 'deny' to skip this tool, 'abort' to stop the loop.
 */
export type ToolValidationCallback = (
  toolName: string,
  args: unknown,
) => Promise<'allow' | 'deny' | 'abort'>;

// ── Chat chunk types (yielded by streamChat) ────────────────────────────

/**
 * Chunk types yielded by streamChat.
 * - text: content from the LLM
 * - tool: tool execution state change
 * - done: stream finished
 */
export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: string; status?: string; call?: { params: unknown; result: unknown }; done: boolean }
  | { type: 'approval_request'; requestId: string; toolName: string; args: unknown }
  | { type: 'approval_result'; requestId: string; decision: 'allow' | 'deny' | 'abort' }
  | { type: 'error'; error: string }
  | { type: 'done'; finishReason: string };

// ── Discovery model info (from engine API) ─────────────────────────────

/**
 * Model info returned from engine discovery (fetchModels).
 * This is the "actual" model — the raw data from the engine API.
 */
export interface DiscoveredModel {
  /** Model ID: e.g., "anthropic/claude-opus-4.6" */
  id: string;
  /** Engine ID that discovered this model */
  engine: string;
  /** Context window size (0 if unknown) */
  contextWindow: number;
  /** Model capabilities */
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
}

// ── Fetch models (actual layer) ────────────────────────────────────────

/**
 * Fetch available models from an engine via its API.
 * Returns engine-prefixed model IDs (e.g., "openrouter/anthropic/claude-opus-4.6").
 * This operates on the "actual" layer — no virtual provider awareness.
 *
 * The Vercel AI SDK does not provide a loadModels() function, so we call
 * each provider's models API directly via fetch.
 */
export async function fetchModels(
  engineId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<DiscoveredModel[]> {
  // Mock engine returns static models — no network call
  if (engineId === 'mock') {
    return getMockModels().map(m => ({
      id: m.id,
      engine: 'mock',
      contextWindow: m.contextWindow || 0,
      capabilities: m.capabilities,
    }));
  }

  const engine = ENGINE_MAP.get(engineId);
  if (!engine) return [];

  try {
    return await fetchModelsFromApi(engineId, engine, apiKey, baseUrl);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Adapter] Failed to fetch models for engine ${engineId}:`, msg);
    return [];
  }
}

/**
 * Fetch models from the provider's API endpoint.
 * Most OpenAI-compatible providers support GET /v1/models.
 * Provider-specific APIs are handled per-engine.
 */
async function fetchModelsFromApi(
  engineId: string,
  engine: EngineInfo,
  apiKey?: string,
  baseUrl?: string,
): Promise<DiscoveredModel[]> {
  const effectiveBaseUrl = baseUrl || engine.defaultBaseUrl;

  // Anthropic uses a different API format
  if (engineId === 'anthropic') {
    return fetchAnthropicModels(engineId, apiKey, effectiveBaseUrl);
  }

  // Google Gemini uses a different API format
  if (engineId === 'gemini') {
    return fetchGeminiModels(engineId, apiKey, effectiveBaseUrl);
  }

  // AWS Bedrock - skip for now (requires AWS SDK auth)
  if (engineId === 'bedrock') {
    return [];
  }

  // OpenAI-compatible: GET /models (or /v1/models)
  if (!effectiveBaseUrl) return [];

  const modelsUrl = effectiveBaseUrl.endsWith('/v1')
    ? `${effectiveBaseUrl}/models`
    : effectiveBaseUrl.endsWith('/')
      ? `${effectiveBaseUrl}models`
      : `${effectiveBaseUrl}/models`;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => 'unknown')}`);
  }

  const data = await resp.json() as unknown;
  const obj = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const models = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : [];

  return models.map((m: unknown) => {
    const item = m && typeof m === 'object' ? m as Record<string, unknown> : {};
    return {
      id: String(item.id ?? item.name ?? ''),
    engine: engineId,
    contextWindow: Number(item.context_length ?? item.context_window ?? 0),
    capabilities: {
      supportsTools: engine.supportsTools,
      supportsVision: false,
    },
  };
  });
}

/** Fetch models from Anthropic's /v1/models API */
async function fetchAnthropicModels(
  engineId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<DiscoveredModel[]> {
  const url = `${baseUrl || 'https://api.anthropic.com'}/v1/models`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`Anthropic HTTP ${resp.status}`);
  }

  const data = await resp.json() as unknown;
  const obj = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const models = Array.isArray(obj.data) ? obj.data : [];

  return models.map((m: unknown) => {
    const item = m && typeof m === 'object' ? m as Record<string, unknown> : {};
    return {
      id: String(item.id ?? ''),
    engine: engineId,
    contextWindow: Number(item.max_tokens ?? 0),
    capabilities: {
      supportsTools: true,
      supportsVision: true,
    },
  };
  });
}

/** Fetch models from Google's Gemini API */
async function fetchGeminiModels(
  engineId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<DiscoveredModel[]> {
  const base = baseUrl || 'https://generativelanguage.googleapis.com';
  const url = `${base}/v1beta/models${apiKey ? `?key=${apiKey}` : ''}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`Gemini HTTP ${resp.status}`);
  }

  const data = await resp.json() as unknown;
  const obj = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const models = Array.isArray(obj.models) ? obj.models : [];

  return models
    .filter((m: unknown) => {
      const item = m && typeof m === 'object' ? m as Record<string, unknown> : {};
      const methods = item.supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes('generateContent');
    })
    .map((m: unknown) => {
      const item = m && typeof m === 'object' ? m as Record<string, unknown> : {};
      const name = item.name;
      const id = typeof name === 'string' ? name.replace('models/', '') : String(name ?? '');
      return {
        id,
      engine: engineId,
      contextWindow: Number(item.inputTokenLimit ?? 0),
      capabilities: {
        supportsTools: true,
        supportsVision: true,
      },
    };
    });
}

// ── Stream chat (actual layer) ─────────────────────────────────────────

/**
 * Stream a chat response from an engine using the Vercel AI SDK.
 * Operates on the "actual" layer — takes engine ID and engine model ID directly.
 * The caller (state.ts) is responsible for virtual → actual resolution.
 *
 * When tools are provided, creates Vercel AI SDK tool() objects and uses
 * streamText's built-in step loop (stopWhen) for automatic tool execution.
 *
 * @param engineId - Engine type (e.g., "openrouter")
 * @param engineModelId - Actual model ID the engine expects
 * @param messages - Chat messages (role + content)
 * @param apiKey - API key (optional for keyless engines)
 * @param baseUrl - Custom base URL (optional)
 * @param params - Chat parameters (temperature, top_p, etc.)
 * @param tools - Tool definitions to register (empty = no tools)
 * @param toolExecutor - Callback to execute tool calls (required if tools provided)
 * @param toolValidator - Optional callback for approval tiers
 */
export interface ChatMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export async function* streamChat(
  engineId: string,
  engineModelId: string,
  messages: ChatMessage[],
  apiKey?: string,
  baseUrl?: string,
  params?: ChatParams,
  tools?: ToolDefinition[],
  toolExecutor?: ToolExecutor,
  toolValidator?: ToolValidationCallback,
  maxSteps: number = 10,
): AsyncGenerator<ChatChunk> {
  // Mock engine — no network, no key, deterministic
  if (engineId === 'mock') {
    yield* mockStreamChat(engineModelId, messages);
    return;
  }

  const engineInfo = ENGINE_MAP.get(engineId);
  if (!engineInfo) {
    console.error(`[Adapter] Unknown engine: ${engineId}`);
    yield { type: 'error', error: `Unknown engine: ${engineId}` };
    yield { type: 'done', finishReason: 'error' };
    return;
  }

  debug(`[Adapter] streamChat: engine="${engineId}", model="${engineModelId}", messages=${messages.length}, tools=${tools?.length || 0}`);

  try {
    // Create the Vercel AI SDK model instance (async — loads provider package on demand)
    const model = await engineInfo.createModel(engineModelId, {
      apiKey,
      baseURL: baseUrl,
    });

    // Convert messages to Vercel AI SDK format
    const aiMessages = convertMessages(messages);

    // Convert ToolDefinition[] to Vercel AI SDK tool() objects
    const hasTools = tools && tools.length > 0 && toolExecutor;
    let aiTools: ToolSet | undefined;

    if (hasTools) {
      const toolRecord: ToolSet = {};
      for (const t of tools) {
        let schema: JSONSchema7;
        try {
          schema = JSON.parse(t.inputSchema) as JSONSchema7;
        } catch {
          schema = { type: 'object', properties: {} };
        }
        if (!schema.type) {
          schema.type = 'object';
        }
        if (!schema.properties) {
          schema.properties = {};
        }

        toolRecord[t.name] = tool({
          description: t.description,
          inputSchema: jsonSchema(schema),
          execute: async (args: Record<string, unknown>) => {
            if (toolValidator) {
              const decision = await toolValidator(t.name, args);
              if (decision === 'deny') return { error: 'Tool execution denied by policy' };
              if (decision === 'abort') throw new Error('Tool execution aborted by policy');
            }
            return toolExecutor!(t.name, args);
          },
        });
      }
      aiTools = toolRecord;
    }

    const streamOptions = {
      model,
      messages: aiMessages,
      ...(aiTools ? { tools: aiTools, maxSteps } : {}),
      ...(params?.temperature != null ? { temperature: params.temperature } : {}),
      ...(params?.maxTokens != null ? { maxTokens: params.maxTokens } : {}),
      ...(params?.top_p != null ? { topP: params.top_p } : {}),
      ...(params?.top_k != null ? { topK: params.top_k } : {}),
    };

    const result = streamText(streamOptions);

    // Iterate over the full stream and yield our ChatChunk format
    let gotContent = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            yield { type: 'text', text: part.text };
            gotContent = true;
          }
          break;

        case 'tool-call':
          yield {
            type: 'tool',
            name: part.toolName,
            state: 'running',
            call: { params: part.input, result: undefined },
            done: false,
          };
          break;

        case 'tool-result':
          yield {
            type: 'tool',
            name: part.toolName,
            state: 'completed',
            call: { params: part.input, result: part.output },
            done: true,
          };
          break;

        case 'error': {
          console.error(`[Adapter] Stream error for ${engineId}/${engineModelId}:`, part.error);
          const errMsg = part.error instanceof Error ? part.error.message
            : typeof part.error === 'string' ? part.error
            : JSON.stringify(part.error);
          yield { type: 'error', error: errMsg };
          break;
        }

        case 'finish':
          yield { type: 'done', finishReason: part.finishReason || 'stop' };
          return;
      }
    }

    // If we got content but no explicit finish event, emit done
    if (gotContent) {
      yield { type: 'done', finishReason: 'stop' };
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Adapter] Chat error for ${engineId}/${engineModelId}:`, errorMessage);
    yield { type: 'error', error: `${engineId}/${engineModelId}: ${errorMessage}` };
    yield { type: 'done', finishReason: 'error' };
  }
}

// ── Message conversion ─────────────────────────────────────────────────

/**
 * Convert our internal message format to Vercel AI SDK ModelMessage format.
 */
function convertMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map(m => {
    switch (m.role) {
      case 'system':
        return { role: 'system' as const, content: m.content };

      case 'user':
        return { role: 'user' as const, content: m.content };

      case 'assistant':
        if (m.tool_calls && m.tool_calls.length > 0) {
          const parts: AssistantModelMessage['content'] = [];
          if (m.content) {
            parts.push({ type: 'text', text: m.content });
          }
          for (const tc of m.tool_calls) {
            const item = tc && typeof tc === 'object' ? tc as Record<string, unknown> : {};
            const args = item.arguments;
            parts.push({
              type: 'tool-call',
              toolCallId: String(item.id ?? ''),
              toolName: String(item.name ?? ''),
              input: typeof args === 'string' ? JSON.parse(args) as Record<string, unknown> : (args && typeof args === 'object' ? args as Record<string, unknown> : {}),
            });
          }
          return { role: 'assistant' as const, content: parts };
        }
        return { role: 'assistant' as const, content: m.content };

      case 'tool':
        return {
          role: 'tool' as const,
          content: [{
            type: 'tool-result',
            toolCallId: m.tool_call_id || '',
            toolName: m.name || '',
            output: { type: 'text' as const, value: m.content || '' },
          }],
        };

      default:
        return { role: 'user' as const, content: m.content };
    }
  });
}
