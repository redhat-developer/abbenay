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

import { streamText, jsonSchema, tool, stepCountIs } from 'ai';
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
  /** Human-friendly name for UI display (falls back to id if omitted) */
  displayName?: string;
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

// ── Provider loading ────────────────────────────────────────────────────

/**
 * Static import map for @ai-sdk/* provider packages.
 *
 * esbuild cannot follow `import(variable)` — it emits a bare `require()`
 * that fails inside a Node.js SEA (no node_modules on disk).  Using
 * string-literal specifiers lets esbuild resolve and bundle them in the
 * SEA build, while the @abbenay/core build externalises them via the
 * `external: ['@ai-sdk/*']` glob as before.
 */
const PROVIDER_LOADERS: Record<string, () => Promise<unknown>> = {
  '@ai-sdk/openai':            () => import('@ai-sdk/openai'),
  '@ai-sdk/anthropic':         () => import('@ai-sdk/anthropic'),
  '@ai-sdk/google':            () => import('@ai-sdk/google'),
  '@ai-sdk/google-vertex/anthropic': () => import('@ai-sdk/google-vertex/anthropic'),
  '@ai-sdk/mistral':           () => import('@ai-sdk/mistral'),
  '@ai-sdk/xai':               () => import('@ai-sdk/xai'),
  '@ai-sdk/deepseek':          () => import('@ai-sdk/deepseek'),
  '@ai-sdk/groq':              () => import('@ai-sdk/groq'),
  '@ai-sdk/cohere':            () => import('@ai-sdk/cohere'),
  '@ai-sdk/amazon-bedrock':    () => import('@ai-sdk/amazon-bedrock'),
  '@ai-sdk/fireworks':         () => import('@ai-sdk/fireworks'),
  '@ai-sdk/togetherai':        () => import('@ai-sdk/togetherai'),
  '@ai-sdk/perplexity':        () => import('@ai-sdk/perplexity'),
  '@ai-sdk/openai-compatible': () => import('@ai-sdk/openai-compatible'),
};

/**
 * Load an @ai-sdk/* provider package by name.
 * Uses the static PROVIDER_LOADERS map so the SEA build can bundle them.
 */
async function loadProviderFactory(packageName: string, exportName: string): Promise<unknown> {
  const loader = PROVIDER_LOADERS[packageName];
  if (!loader) {
    throw new Error(`Unknown AI SDK provider package '${packageName}'`);
  }
  try {
    const mod = await loader();
    const exported = mod as Record<string, unknown>;
    const factory = exported[exportName];
    if (!factory) {
      throw new Error(`Package '${packageName}' does not export '${exportName}'`);
    }
    return factory;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      const installName = packageName.startsWith('@')
        ? packageName.split('/').slice(0, 2).join('/')
        : packageName.split('/')[0];
      throw new Error(
        `AI SDK provider package '${packageName}' is not installed. ` +
        `Install it with: npm install ${installName}`
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

type VertexAnthropicProviderFactory = (config: Record<string, unknown>) => (modelId: string) => LanguageModel;

/**
 * Strip fields the Anthropic Vertex API rejects but the AI SDK may inject.
 * Also removes empty text content blocks which Vertex Anthropic rejects with
 * "text content blocks must be non-empty".
 * Returns the sanitized JSON string and the list of removed field names,
 * or null if no changes were needed.
 */
export function sanitizeVertexRequestBody(bodyStr: string): { body: string; removed: string[] } | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  const removed: string[] = [];
  if ('stream_options' in body) { delete body.stream_options; removed.push('stream_options'); }

  // Filter empty/whitespace text content blocks from messages — Vertex Anthropic rejects them.
  // This handles both string content (e.g. content: ' ') and array content
  // (e.g. [{type:'text', text:' '}]). Messages that have no content remaining
  // after filtering are dropped entirely.
  if (Array.isArray(body.messages)) {
    let messagesChanged = false;
    const filteredMessages: Array<Record<string, unknown>> = [];
    for (const msg of body.messages as Array<Record<string, unknown>>) {
      // String content: if empty/whitespace, drop the message
      if (typeof msg.content === 'string') {
        if (msg.content.trim() === '') {
          messagesChanged = true;
          continue;
        }
        filteredMessages.push(msg);
        continue;
      }
      // Array content: filter whitespace-only text blocks
      if (!Array.isArray(msg.content)) {
        filteredMessages.push(msg);
        continue;
      }
      const filtered = (msg.content as Array<Record<string, unknown>>).filter(
        block => !(block.type === 'text' && typeof block.text === 'string' && block.text.trim() === ''),
      );
      if (filtered.length === 0) {
        messagesChanged = true;
        continue;
      }
      if (filtered.length !== (msg.content as unknown[]).length) {
        messagesChanged = true;
        filteredMessages.push({ ...msg, content: filtered });
      } else {
        filteredMessages.push(msg);
      }
    }
    if (messagesChanged) {
      body.messages = filteredMessages;
      removed.push('empty_text_blocks');
    }
  }

  if (removed.length === 0) {
    return null;
  }
  return { body: JSON.stringify(body), removed };
}

export type SseConversionResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'parse-error' | 'non-text-content' };

/**
 * Convert an Anthropic Messages API JSON response into SSE events that
 * the Vercel AI SDK's @ai-sdk/google-vertex/anthropic parser expects.
 *
 * Returns `{ ok: false, reason }` when conversion cannot be performed:
 * - `'parse-error'`: the input is not valid JSON or not an Anthropic Messages response
 * - `'non-text-content'`: the response contains unsupported content blocks
 *   (e.g. null entries) that cannot be faithfully represented.
 *   `text` and `tool_use` blocks are handled.
 */
export function convertAnthropicJsonToSse(jsonStr: string): SseConversionResult {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'parse-error' };
  }
  if (!Array.isArray(msg.content)) {
    return { ok: false, reason: 'parse-error' };
  }
  const content = msg.content as Array<Record<string, unknown>>;

  const events: string[] = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msg.id || '', type: 'message', role: 'assistant', content: [], model: msg.model || '', stop_reason: null, stop_sequence: null, usage: msg.usage || { input_tokens: 0, output_tokens: 0 } } })}\n`,
  ];

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object') {
      return { ok: false, reason: 'non-text-content' };
    }
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })}\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } })}\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n`,
      );
    } else if (block.type === 'tool_use') {
      const inputStr = block.input != null ? JSON.stringify(block.input) : '{}';
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id || '', name: block.name || '', input: {} } })}\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: inputStr } })}\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n`,
      );
    } else {
      return { ok: false, reason: 'non-text-content' };
    }
  }

  const stopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : 'end_turn';
  const stopSequence = typeof msg.stop_sequence === 'string' || msg.stop_sequence === null
    ? msg.stop_sequence
    : null;
  events.push(
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: stopSequence }, usage: msg.usage || { output_tokens: 0 } })}\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n`,
  );
  return { ok: true as const, body: `${events.join('\n')}\n` };
}

/**
 * Create model via @ai-sdk/google-vertex/anthropic (dynamically loaded).
 *
 * Supports two modes:
 * - Standard Vertex AI: uses Google Cloud Application Default Credentials (ADC)
 * - Bearer-token proxy: when apiKey is set, injects it as the Authorization
 *   header via a synthetic authClient, bypassing Google credential discovery.
 *
 * For corporate proxies with self-signed certificates, set the standard
 * NODE_EXTRA_CA_CERTS environment variable to the CA bundle path instead
 * of disabling TLS verification.
 */
async function vertexAnthropicProvider(
  config: ProviderFactoryConfig,
  modelId: string,
): Promise<LanguageModel> {
  const factory = await loadProviderFactory(
    '@ai-sdk/google-vertex/anthropic', 'createVertexAnthropic',
  ) as VertexAnthropicProviderFactory;

  const providerConfig: Record<string, unknown> = {};
  if (config.baseURL) {
    providerConfig.baseURL = config.baseURL;
  }
  if (config.apiKey) {
    providerConfig.googleAuthOptions = {
      authClient: {
        getAccessToken: async () => ({ token: config.apiKey }),
        getRequestHeaders: async () => ({ Authorization: `Bearer ${config.apiKey}` }),
      },
    };
  }
  providerConfig.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const patchedInit = { ...(init ?? {}) };
    if (typeof patchedInit.body === 'string') {
      const result = sanitizeVertexRequestBody(patchedInit.body);
      if (result) {
        patchedInit.body = result.body;
        debug(`[Adapter] vertex-anthropic: stripped [${result.removed}] from request body`);
      }
    }
    return fetch(input, patchedInit).then(async (resp) => {
      const ct = resp.headers.get('content-type') || '';
      if (resp.status === 200 && ct.includes('application/json') && !ct.includes('event-stream')) {
        const text = await resp.text();
        const result = convertAnthropicJsonToSse(text);
        if (result.ok) {
          debug(`[Adapter] vertex-anthropic: converted JSON response to SSE`);
          const sseHeaders = new Headers(resp.headers);
          sseHeaders.set('content-type', 'text/event-stream');
          return new Response(result.body, { status: 200, statusText: 'OK', headers: sseHeaders });
        }
        if (result.reason === 'non-text-content') {
          debug(
            '[Adapter] vertex-anthropic: proxy returned application/json with unsupported content blocks. ' +
            'JSON→SSE conversion supports text and tool_use blocks only.',
          );
        } else {
          debug('[Adapter] vertex-anthropic: proxy returned application/json but body is not valid Anthropic Messages API JSON.');
        }
        return new Response(text, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      }
      return resp;
    });
  };

  const provider = factory(providerConfig);
  return provider(modelId);
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
  'vertex-anthropic': {
    id: 'vertex-anthropic',
    requiresKey: false, // Google ADC by default; Bearer token optional via apiKey
    defaultEnvVar: 'VERTEX_ANTHROPIC_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) => vertexAnthropicProvider(config, modelId),
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
  redhat: {
    id: 'redhat',
    displayName: 'Red Hat AI',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultEnvVar: 'REDHAT_AI_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('redhat', 'http://127.0.0.1:8000/v1', config, modelId),
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

  // Vertex Anthropic - no standard models discovery API
  if (engineId === 'vertex-anthropic') {
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
  jsonMode: boolean = false,
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

    // Convert ToolDefinition[] to Vercel AI SDK tool() objects.
    // With an executor: Abbenay runs tools (auto mode).
    // Without an executor: schemas only (passthrough) — client executes tools.
    const hasTools = !!(tools && tools.length > 0);
    const effectiveMaxSteps = hasTools && !toolExecutor ? 1 : maxSteps;
    let aiTools: ToolSet | undefined;

    if (hasTools) {
      const toolRecord: ToolSet = {};
      for (const t of tools!) {
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

        if (toolExecutor) {
          toolRecord[t.name] = tool({
            description: t.description,
            inputSchema: jsonSchema(schema),
            execute: async (args: Record<string, unknown>) => {
              if (toolValidator) {
                const decision = await toolValidator(t.name, args);
                if (decision === 'deny') return { error: 'Tool execution denied by policy' };
                if (decision === 'abort') throw new Error('Tool execution aborted by policy');
              }
              return toolExecutor(t.name, args);
            },
          });
        } else {
          toolRecord[t.name] = tool({
            description: t.description,
            inputSchema: jsonSchema(schema),
          });
        }
      }
      aiTools = toolRecord;
    }

    const result = streamText({
      model,
      messages: aiMessages,
      ...(aiTools ? { tools: aiTools } : {}),
      ...(effectiveMaxSteps > 1 ? { stopWhen: stepCountIs(effectiveMaxSteps) } : {}),
      ...(params?.temperature != null ? { temperature: params.temperature } : {}),
      ...(params?.maxTokens != null ? { maxTokens: params.maxTokens } : {}),
      ...(params?.top_p != null ? { topP: params.top_p } : {}),
      ...(params?.top_k != null ? { topK: params.top_k } : {}),
      ...(params?.timeout != null ? { timeout: params.timeout } : {}),
      ...(jsonMode ? { responseFormat: { type: 'json' as const } } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            yield { type: 'text', text: part.text };
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
          break;
      }
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
 * Normalize a tool-call entry from flat Abbenay shape or OpenAI nested shape.
 * Flat: `{ id, name, arguments }`
 * OpenAI: `{ id, type, function: { name, arguments } }`
 */
export function extractToolCallFields(tc: unknown): {
  id: string;
  name: string;
  arguments: unknown;
} {
  const item = tc && typeof tc === 'object' ? tc as Record<string, unknown> : {};
  const fn = item.function && typeof item.function === 'object'
    ? item.function as Record<string, unknown>
    : undefined;
  return {
    id: String(item.id ?? ''),
    name: String(fn?.name ?? item.name ?? ''),
    arguments: fn?.arguments ?? item.arguments,
  };
}

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

      case 'assistant': {
        const parts: AssistantModelMessage['content'] = [];
        if (m.content && m.content.trim()) {
          parts.push({ type: 'text', text: m.content });
        }
        if (m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            const { id, name, arguments: args } = extractToolCallFields(tc);
            let input: Record<string, unknown> = {};
            if (typeof args === 'string') {
              try {
                input = JSON.parse(args) as Record<string, unknown>;
              } catch {
                input = {};
              }
            } else if (args && typeof args === 'object') {
              input = args as Record<string, unknown>;
            }
            parts.push({
              type: 'tool-call',
              toolCallId: id,
              toolName: name,
              input,
            });
          }
        }
        if (parts.length === 0) {
          return { role: 'assistant' as const, content: m.content || '' };
        }
        return { role: 'assistant' as const, content: parts };
      }

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
