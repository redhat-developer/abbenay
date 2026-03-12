/**
 * OpenAI-compatible API routes — `/v1/models` and `/v1/chat/completions`.
 *
 * Translates between the OpenAI wire format and Abbenay's DaemonState,
 * making Abbenay a drop-in replacement for any OpenAI-compatible client
 * (Cursor, Continue, aider, any `openai` SDK script, etc.).
 */

import * as crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { DaemonState } from '../../daemon/state.js';
import type { ModelInfo, ChatToolOptions } from '../../core/state.js';
import type { ChatChunk } from '../../core/engines.js';

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
    delta.tool_calls = [{
      index: toolCallIndex,
      id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'function',
      function: {
        name: chunk.name,
        arguments: typeof chunk.call.params === 'string'
          ? chunk.call.params
          : JSON.stringify(chunk.call.params ?? {}),
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
): object {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: mapFinishReason(finishReason),
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function openAIError(res: Response, status: number, message: string, type: string): void {
  res.status(status).json({ error: { message, type } });
}

// ── Route registration ──────────────────────────────────────────────────

// Future M2: add optional Bearer token auth here by reading config.yaml -> server.api_key
// and checking the Authorization header before each route handler.

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
    } = req.body;

    if (!model) {
      openAIError(res, 400, 'model is required', 'invalid_request_error');
      return;
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      openAIError(res, 400, 'messages is required and must be a non-empty array', 'invalid_request_error');
      return;
    }

    const chatMessages = messages.map(
      (m: { role?: string; content?: string; name?: string; tool_call_id?: string; tool_calls?: unknown }) => ({
        role: m.role || 'user',
        content: m.content || '',
        name: m.name || undefined,
        tool_call_id: m.tool_call_id || undefined,
        tool_calls: m.tool_calls || undefined,
      }),
    );

    const requestParams: Record<string, unknown> = {};
    if (temperature != null) requestParams.temperature = temperature;
    if (top_p != null) requestParams.top_p = top_p;
    const effectiveMaxTokens = max_tokens ?? max_completion_tokens;
    if (effectiveMaxTokens != null) requestParams.maxTokens = effectiveMaxTokens;
    const hasParams = Object.keys(requestParams).length > 0;

    // OpenAI-compatible transport has no approval UI, so tools are disabled
    // to preserve secure-by-default (DR-019). M2 can add opt-in via config
    // that would parse `tools` from the request and wire onToolApprovalNeeded.
    const toolOptions: ChatToolOptions = {
      toolMode: 'none',
      tools: undefined,
    };

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
  messages: Array<{ role: string; content: string }>,
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
  messages: Array<{ role: string; content: string }>,
  params: Record<string, unknown> | undefined,
  toolOptions: ChatToolOptions,
  chatId: string,
  created: number,
): Promise<void> {
  try {
    let content = '';
    let finishReason = 'stop';

    for await (const chunk of state.chat(model, messages, params, toolOptions)) {
      if (chunk.type === 'text') {
        content += chunk.text;
      } else if (chunk.type === 'done') {
        finishReason = chunk.finishReason;
      } else if (chunk.type === 'error') {
        openAIError(res, 500, chunk.error, 'server_error');
        return;
      }
    }

    res.json(buildCompleteResponse(chatId, model, created, content, finishReason));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    openAIError(res, 500, msg, 'server_error');
  }
}
