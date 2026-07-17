/**
 * OpenAI-compatible API routes — `/v1/models` and `/v1/chat/completions`.
 *
 * Translates between the OpenAI wire format and Abbenay's DaemonState,
 * making Abbenay a drop-in replacement for any OpenAI-compatible client
 * (Cursor, Continue, aider, Open WebUI, any `openai` SDK script, etc.).
 *
 * Tools on `/v1` are off by default (DR-019). Opt-in passthrough (DR-032)
 * forwards client `tools` and returns `tool_calls` for client-side execution.
 */

import * as crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { DaemonState } from '../../daemon/state.js';
import type { ModelInfo, ChatToolOptions } from '../../core/state.js';
import type { ChatChunk, ToolDefinition } from '../../core/engines.js';
import { extractToolCallFields } from '../../core/engines.js';
import {
  loadConfig,
  type ConfigFile,
  type OpenAICompatToolsMode,
} from '../../core/config.js';

// ── Format helpers (exported for unit testing) ──────────────────────────

export function mapModelToOpenAI(model: ModelInfo): {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
} {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.engine,
  };
}

export function mapFinishReason(reason: string): string {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'tool-calls') return 'tool_calls';
  return 'stop';
}

export function generateChatId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export interface StreamChunkOptions {
  id: string;
  model: string;
  created: number;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Resolve `/v1` tools mode: model override → global → `off`.
 */
export function resolveOpenAICompatToolsMode(
  compositeModelId: string,
  config: ConfigFile | null | undefined,
): OpenAICompatToolsMode {
  const globalMode = config?.openai_compat?.tools === 'passthrough' ? 'passthrough' : 'off';
  const slashIdx = compositeModelId.indexOf('/');
  if (slashIdx === -1) {
    return globalMode;
  }
  const providerId = compositeModelId.substring(0, slashIdx);
  const modelName = compositeModelId.substring(slashIdx + 1);
  const modelMode = config?.providers?.[providerId]?.models?.[modelName]?.openai_compat_tools;
  if (modelMode === 'passthrough' || modelMode === 'off') {
    return modelMode;
  }
  return globalMode;
}

/** Defensive JSON.stringify for untrusted client payloads. */
function safeJsonStringify(value: unknown, fallback: string): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Coerce OpenAI tool `parameters` into a JSON Schema object safe for engines.ts.
 */
export function coerceToolParametersSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const obj = parameters as Record<string, unknown>;
    const properties = (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties))
      ? obj.properties
      : {};
    return {
      ...obj,
      type: typeof obj.type === 'string' ? obj.type : 'object',
      properties,
    };
  }
  return { type: 'object', properties: {} };
}

/**
 * Map OpenAI `tools` request entries to Abbenay ToolDefinition[].
 */
export function mapOpenAIToolsToDefinitions(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const out: ToolDefinition[] = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Record<string, unknown>;
    // OpenAI tools are type:"function"; reject other tool kinds.
    if (t.type !== undefined && t.type !== 'function') continue;
    const fn = t.function && typeof t.function === 'object'
      ? t.function as Record<string, unknown>
      : undefined;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    const description = typeof fn?.description === 'string' ? fn.description : '';
    const parameters = coerceToolParametersSchema(fn?.parameters);
    out.push({
      name,
      description,
      inputSchema: safeJsonStringify(parameters, '{"type":"object","properties":{}}'),
    });
  }
  return out;
}

/**
 * Normalize OpenAI nested tool_calls on inbound messages to a stable shape
 * that convertMessages / engines understand (also accepts flat entries).
 */
export function normalizeOpenAIToolCalls(toolCalls: unknown): OpenAIToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }
  const out: OpenAIToolCall[] = [];
  for (const tc of toolCalls) {
    const { id, name, arguments: args } = extractToolCallFields(tc);
    const toolName = name.trim();
    if (!toolName) continue;
    const argStr = typeof args === 'string'
      ? args
      : safeJsonStringify(args ?? {}, '{}');
    out.push({
      id: id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'function' as const,
      function: { name: toolName, arguments: argStr },
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Coerce a single OpenAI chat message into Abbenay ChatMessage primitives.
 * Non-string content/role/name/tool_call_id must not reach core `.trim()` paths.
 */
export function normalizeOpenAIChatMessage(raw: unknown): {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
} {
  const m = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const role = typeof m.role === 'string' && m.role.trim() ? m.role : 'user';
  const content = typeof m.content === 'string' ? m.content : '';
  const name = typeof m.name === 'string' && m.name ? m.name : undefined;
  const tool_call_id = typeof m.tool_call_id === 'string' && m.tool_call_id
    ? m.tool_call_id
    : undefined;
  return {
    role,
    content,
    name,
    tool_call_id,
    tool_calls: normalizeOpenAIToolCalls(m.tool_calls),
  };
}

export function buildStreamChunk(
  chunk: ChatChunk,
  opts: StreamChunkOptions,
  toolCallIndex: number,
  isFirstChunk: boolean,
): object | null {
  const base = {
    id: opts.id,
    object: 'chat.completion.chunk' as const,
    created: opts.created,
    model: opts.model,
  };

  if (chunk.type === 'text') {
    const delta: Record<string, unknown> = { content: chunk.text };
    if (isFirstChunk) delta.role = 'assistant';
    return { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
  }

  if (chunk.type === 'tool' && chunk.state === 'running' && chunk.call) {
    const delta: Record<string, unknown> = {};
    if (isFirstChunk) delta.role = 'assistant';
    const toolName = (chunk.name || '').trim();
    if (!toolName) {
      return null;
    }
    delta.tool_calls = [{
      index: toolCallIndex,
      id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: typeof chunk.call.params === 'string'
          ? chunk.call.params
          : safeJsonStringify(chunk.call.params ?? {}, '{}'),
      },
    }];
    return { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
  }

  if (chunk.type === 'done') {
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(chunk.finishReason) }],
    };
  }

  // approval_request, approval_result, tool results, errors — not mapped to OpenAI streaming
  return null;
}

export function buildCompleteResponse(
  id: string,
  model: string,
  created: number,
  content: string,
  finishReason: string,
  toolCalls?: OpenAIToolCall[],
): object {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: toolCalls && toolCalls.length > 0 ? (content || null) : content,
  };
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapFinishReason(finishReason),
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function openAIError(res: Response, status: number, message: string, type: string): void {
  res.status(status).json({ error: { message, type } });
}

function toolCallFromChunk(chunk: ChatChunk): OpenAIToolCall | null {
  if (chunk.type !== 'tool' || chunk.state !== 'running' || !chunk.call) {
    return null;
  }
  const name = (chunk.name || '').trim();
  if (!name) {
    return null;
  }
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: {
      name,
      arguments: typeof chunk.call.params === 'string'
        ? chunk.call.params
        : safeJsonStringify(chunk.call.params ?? {}, '{}'),
    },
  };
}

// ── Route registration ──────────────────────────────────────────────────

// Auth is enforced globally in createWebApp() via Bearer / SameSite cookie middleware.
// See http-security.ts and config.yaml → server.api_token / ABBENAY_API_TOKEN.

export function registerOpenAIRoutes(app: Express, state: DaemonState): void {
  /**
   * GET /v1/models — list available models in OpenAI format.
   */
  app.get('/v1/models', async (_req: Request, res: Response) => {
    try {
      const models = await state.listModels();
      res.json({
        object: 'list',
        data: models.map(mapModelToOpenAI),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      openAIError(res, 500, msg, 'server_error');
    }
  });

  /**
   * POST /v1/chat/completions — chat with streaming or non-streaming response.
   */
  app.post('/v1/chat/completions', (req: Request, res: Response) => {
    const {
      model,
      messages,
      stream,
      temperature,
      top_p,
      max_tokens,
      max_completion_tokens,
      tools,
    } = req.body;

    if (!model) {
      openAIError(res, 400, 'model is required', 'invalid_request_error');
      return;
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      openAIError(res, 400, 'messages is required and must be a non-empty array', 'invalid_request_error');
      return;
    }

    const chatMessages = messages.map((m: unknown) => normalizeOpenAIChatMessage(m));

    const requestParams: Record<string, unknown> = {};
    if (temperature != null) requestParams.temperature = temperature;
    if (top_p != null) requestParams.top_p = top_p;
    const effectiveMaxTokens = max_tokens ?? max_completion_tokens;
    if (effectiveMaxTokens != null) requestParams.maxTokens = effectiveMaxTokens;
    const hasParams = Object.keys(requestParams).length > 0;

    // Secure-by-default (DR-019): tools off unless config opts into passthrough (DR-032).
    // Skip disk config + tool mapping when the request has no tools (common default path).
    let toolOptions: ChatToolOptions = { toolMode: 'none', tools: undefined };
    if (Array.isArray(tools) && tools.length > 0) {
      const config = loadConfig();
      const mode = resolveOpenAICompatToolsMode(String(model), config);
      if (mode === 'passthrough') {
        const mappedTools = mapOpenAIToolsToDefinitions(tools);
        if (mappedTools.length > 0) {
          toolOptions = { toolMode: 'passthrough', tools: mappedTools, maxToolIterations: 1 };
        }
      }
    }

    const chatId = generateChatId();
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      handleStreaming(res, state, model, chatMessages, hasParams ? requestParams : undefined, toolOptions, chatId, created);
    } else {
      handleNonStreaming(res, state, model, chatMessages, hasParams ? requestParams : undefined, toolOptions, chatId, created);
    }
  });
}

// ── Streaming handler ───────────────────────────────────────────────────

function handleStreaming(
  res: Response,
  state: DaemonState,
  model: string,
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] }>,
  params: Record<string, unknown> | undefined,
  toolOptions: ChatToolOptions,
  chatId: string,
  created: number,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  let ended = false;
  let isFirstChunk = true;
  let toolCallIndex = 0;

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

  const opts: StreamChunkOptions = { id: chatId, model, created };

  (async () => {
    try {
      for await (const chunk of state.chat(model, messages, params, toolOptions)) {
        if (ended) break;

        if (chunk.type === 'tool' && chunk.state === 'running') {
          toolCallIndex++;
        }

        const mapped = buildStreamChunk(chunk, opts, toolCallIndex - 1, isFirstChunk);
        if (mapped) {
          safeWrite(`data: ${JSON.stringify(mapped)}\n\n`);
          isFirstChunk = false;
        }

        if (chunk.type === 'error') {
          safeWrite(`data: ${JSON.stringify({ error: { message: chunk.error, type: 'server_error' } })}\n\n`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      safeWrite(`data: ${JSON.stringify({ error: { message: msg, type: 'server_error' } })}\n\n`);
    } finally {
      safeWrite('data: [DONE]\n\n');
      safeEnd();
    }
  })();
}

// ── Non-streaming handler ───────────────────────────────────────────────

async function handleNonStreaming(
  res: Response,
  state: DaemonState,
  model: string,
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] }>,
  params: Record<string, unknown> | undefined,
  toolOptions: ChatToolOptions,
  chatId: string,
  created: number,
): Promise<void> {
  try {
    let content = '';
    let finishReason = 'stop';
    const toolCalls: OpenAIToolCall[] = [];

    for await (const chunk of state.chat(model, messages, params, toolOptions)) {
      if (chunk.type === 'text') {
        content += chunk.text;
      } else if (chunk.type === 'tool') {
        const tc = toolCallFromChunk(chunk);
        if (tc) toolCalls.push(tc);
      } else if (chunk.type === 'done') {
        finishReason = chunk.finishReason;
      } else if (chunk.type === 'error') {
        openAIError(res, 500, chunk.error, 'server_error');
        return;
      }
    }

    res.json(buildCompleteResponse(
      chatId,
      model,
      created,
      content,
      finishReason,
      toolCalls.length > 0 ? toolCalls : undefined,
    ));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    openAIError(res, 500, msg, 'server_error');
  }
}
