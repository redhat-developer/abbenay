import * as vscode from 'vscode';
import { DaemonClient } from '../../daemon/client';
import * as proto from '../../proto/abbenay/v1/service';
import {
  ChatToHostMessage,
  HostToChatMessage,
  ModelInfo,
  SessionInfo,
  SessionDetail,
  MessageInfo,
  ToolCallInfo,
} from '../shared/types';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

/**
 * Active stream abort handler.
 */
let activeStreamAbort: (() => void) | null = null;

/**
 * Pending tool approval requests.
 */
const pendingApprovals = new Map<string, {
  resolve: (decision: 'allow' | 'deny' | 'abort') => void;
}>();

/**
 * Cancel the currently active stream.
 */
export function cancelActiveStream(): void {
  // Resolve any pending approval promises before clearing, otherwise the
  // awaiting handleSendMessage will never continue and the stream handler leaks.
  for (const pending of pendingApprovals.values()) {
    pending.resolve('abort');
  }
  pendingApprovals.clear();

  if (activeStreamAbort) {
    activeStreamAbort();
    activeStreamAbort = null;
  }
}

/**
 * Handle tool approval decision from webview.
 */
function handleApproveToolCall(requestId: string, decision: 'allow' | 'deny' | 'abort'): void {
  const pending = pendingApprovals.get(requestId);
  if (pending) {
    logger.info('[ChatHandler] Tool approval:', requestId, decision);
    pending.resolve(decision);
    pendingApprovals.delete(requestId);
  } else {
    logger.warn('[ChatHandler] No pending approval for requestId:', requestId);
  }
}

/**
 * Handle messages from the webview.
 */
export async function handleChatMessage(
  message: ChatToHostMessage,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  logger.debug('[ChatHandler] Received message:', message.type);

  try {
    switch (message.type) {
      case 'ready':
        await handleReady(webview, client);
        break;

      case 'listModels':
        await handleListModels(webview, client);
        break;

      case 'listSessions':
        await handleListSessions(webview, client);
        break;

      case 'createSession':
        await handleCreateSession(webview, client, message.model, message.topic);
        break;

      case 'deleteSession':
        await handleDeleteSession(webview, client, message.sessionId);
        break;

      case 'getSession':
        await handleGetSession(webview, client, message.sessionId);
        break;

      case 'sendMessage':
        await handleSendMessage(webview, client, message.sessionId, message.content);
        break;

      case 'cancelStream':
        cancelActiveStream();
        break;

      case 'approveToolCall':
        handleApproveToolCall(message.requestId, message.decision);
        break;

      default:
        logger.warn('[ChatHandler] Unknown message type:', (message as { type: string }).type);
    }
  } catch (error) {
    logger.error('[ChatHandler] Error handling message:', error);
    const errorMessage: HostToChatMessage = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      context: message.type,
    };
    webview.postMessage(errorMessage);
  }
}

/**
 * Handle webview ready event - send initial data.
 */
async function handleReady(
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  await Promise.all([
    handleListModels(webview, client),
    handleListSessions(webview, client),
  ]);
}

/**
 * List available models.
 */
async function handleListModels(
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const models = await client.listModels();
  const modelInfos: ModelInfo[] = models.map(m => ({
    id: m.id,
    provider: m.provider,
    name: m.name,
    engine: m.engine,
  }));

  const response: HostToChatMessage = {
    type: 'models',
    models: modelInfos,
  };
  webview.postMessage(response);
}

/**
 * List chat sessions.
 */
async function handleListSessions(
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const sessions = await client.listSessions();
  const sessionInfos: SessionInfo[] = sessions.map(s => ({
    id: s.id,
    model: s.model,
    topic: s.topic,
    messageCount: s.messageCount,
    createdAt: timestampToISO(s.createdAt),
    updatedAt: timestampToISO(s.updatedAt),
  }));

  const response: HostToChatMessage = {
    type: 'sessions',
    sessions: sessionInfos,
  };
  webview.postMessage(response);
}

/**
 * Create a new session.
 */
async function handleCreateSession(
  webview: vscode.Webview,
  client: DaemonClient,
  model: string,
  topic?: string,
): Promise<void> {
  const session = await client.createSession(model, topic);
  const sessionDetail: SessionDetail = {
    id: session.id,
    model: session.model,
    topic: session.topic,
    messageCount: session.messages.length,
    createdAt: timestampToISO(session.createdAt),
    updatedAt: timestampToISO(session.updatedAt),
    messages: session.messages.map(mapMessageToView),
  };

  const response: HostToChatMessage = {
    type: 'sessionCreated',
    session: sessionDetail,
  };
  webview.postMessage(response);

  // Refresh sessions list
  await handleListSessions(webview, client);
}

/**
 * Delete a session.
 */
async function handleDeleteSession(
  webview: vscode.Webview,
  client: DaemonClient,
  sessionId: string,
): Promise<void> {
  await client.deleteSession(sessionId);
  await handleListSessions(webview, client);
}

/**
 * Get session details with messages.
 */
async function handleGetSession(
  webview: vscode.Webview,
  client: DaemonClient,
  sessionId: string,
): Promise<void> {
  const session = await client.getSession(sessionId, true);
  const sessionDetail: SessionDetail = {
    id: session.id,
    model: session.model,
    topic: session.topic,
    messageCount: session.messages.length,
    createdAt: timestampToISO(session.createdAt),
    updatedAt: timestampToISO(session.updatedAt),
    messages: session.messages.map(mapMessageToView),
  };

  const response: HostToChatMessage = {
    type: 'sessionLoaded',
    session: sessionDetail,
  };
  webview.postMessage(response);
}

/**
 * Send a message and stream the response.
 */
async function handleSendMessage(
  webview: vscode.Webview,
  client: DaemonClient,
  sessionId: string,
  content: string,
): Promise<void> {
  let aborted = false;

  // Set up abort handler
  activeStreamAbort = () => {
    aborted = true;
  };

  try {
    const stream = client.sessionChat({
      sessionId,
      message: {
        role: proto.Role.ROLE_USER,
        content,
        toolCalls: [],
        toolCallId: '',
        name: '',
      },
      options: {
        toolMode: 'auto',
        enableTools: true,
      },
    });

    for await (const chunk of stream) {
      if (aborted) {
        logger.info('[ChatHandler] Stream aborted by user');
        break;
      }

      if (!chunk.chunk) {
        continue;
      }

      switch (chunk.chunk.$case) {
        case 'text': {
          const response: HostToChatMessage = {
            type: 'streamChunk',
            text: chunk.chunk.text.text,
          };
          webview.postMessage(response);
          break;
        }

        case 'toolCall': {
          const response: HostToChatMessage = {
            type: 'toolCall',
            id: chunk.chunk.toolCall.id,
            name: chunk.chunk.toolCall.name,
            args: chunk.chunk.toolCall.arguments,
          };
          webview.postMessage(response);
          break;
        }

        case 'toolResult': {
          const response: HostToChatMessage = {
            type: 'toolResult',
            callId: chunk.chunk.toolResult.toolCallId,
            name: chunk.chunk.toolResult.name,
            content: chunk.chunk.toolResult.content,
            isError: chunk.chunk.toolResult.isError,
          };
          webview.postMessage(response);
          break;
        }

        case 'prompt': {
          const promptId = chunk.chunk.prompt.toolCallId;
          const approvalMsg: HostToChatMessage = {
            type: 'toolApprovalRequest',
            requestId: promptId,
            toolName: chunk.chunk.prompt.toolName,
            promptText: chunk.chunk.prompt.promptText,
          };
          webview.postMessage(approvalMsg);

          const decision = await new Promise<'allow' | 'deny' | 'abort'>((resolve) => {
            pendingApprovals.set(promptId, { resolve });
          });

          logger.info('[ChatHandler] Approval resolved:', promptId, decision);
          break;
        }

        case 'error': {
          const response: HostToChatMessage = {
            type: 'error',
            message: chunk.chunk.error.message,
            context: 'stream',
          };
          webview.postMessage(response);
          break;
        }

        case 'done': {
          const response: HostToChatMessage = {
            type: 'streamDone',
            finishReason: chunk.chunk.done.finishReason,
          };
          webview.postMessage(response);
          break;
        }

        case 'usage':
          // Log token usage but don't send to UI for now
          logger.debug('[ChatHandler] Token usage:', chunk.chunk.usage);
          break;

        default:
          logger.warn('[ChatHandler] Unknown chunk type:', (chunk.chunk as { $case: string }).$case);
      }
    }
  } catch (error) {
    if (!aborted) {
      logger.error('[ChatHandler] Stream error:', error);
      const response: HostToChatMessage = {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        context: 'stream',
      };
      webview.postMessage(response);
    }
  } finally {
    activeStreamAbort = null;
  }
}

/**
 * Convert proto Timestamp to ISO string.
 */
function timestampToISO(timestamp: proto.Timestamp | undefined): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  // Timestamp has seconds as Long
  const seconds = typeof timestamp.seconds === 'number'
    ? timestamp.seconds
    : timestamp.seconds.toNumber();
  return new Date(seconds * 1000).toISOString();
}

/**
 * Convert proto Role enum to string.
 */
function roleToString(role: proto.Role): string {
  switch (role) {
    case proto.Role.ROLE_SYSTEM:
      return 'system';
    case proto.Role.ROLE_USER:
      return 'user';
    case proto.Role.ROLE_ASSISTANT:
      return 'assistant';
    case proto.Role.ROLE_TOOL:
      return 'tool';
    default:
      return 'unknown';
  }
}

/**
 * Map proto Message to view MessageInfo.
 */
function mapMessageToView(message: proto.Message): MessageInfo {
  const toolCalls: ToolCallInfo[] | undefined = message.toolCalls.length > 0
    ? message.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }))
    : undefined;

  return {
    role: roleToString(message.role),
    content: message.content,
    toolCalls,
    toolCallId: message.toolCallId || undefined,
  };
}
