// Message protocol types between webview and extension host.
// All messages use a discriminated union on the `type` field.

// ─── Provider Panel Messages ────────────────────────────────────────

export type ProviderToHostMessage =
  | { type: 'ready' }
  | { type: 'getProviders' }
  | { type: 'getProviderTemplates' }
  | { type: 'getEngines' }
  | { type: 'getConfig'; location?: string }
  | { type: 'configureProvider'; providerId: string; engine?: string; apiKey?: string; envVarName?: string; baseUrl?: string; target?: string; models?: Record<string, { model_id: string }> }
  | { type: 'removeProvider'; providerId: string; target?: string }
  | { type: 'setSecret'; key: string; value: string }
  | { type: 'deleteSecret'; key: string }
  | { type: 'listSecrets' }
  | { type: 'getKeyStatus'; source: string; name: string }
  | { type: 'discoverModels'; engineId: string; providerId?: string; apiKey?: string; baseUrl?: string }
  | { type: 'updateConfig'; config: unknown; location?: string };

export type HostToProviderMessage =
  | { type: 'providers'; providers: ProviderInfo[] }
  | { type: 'templates'; templates: ProviderTemplateInfo[] }
  | { type: 'engines'; engines: EngineInfo[] }
  | { type: 'config'; config: unknown; path: string }
  | { type: 'configureResult'; success: boolean; error?: string; providerId: string }
  | { type: 'secrets'; secrets: SecretInfoView[] }
  | { type: 'keyStatus'; source: string; name: string; exists: boolean }
  | { type: 'discoveredModels'; models: ModelInfo[] }
  | { type: 'error'; message: string; context?: string };

// ─── Chat Panel Messages ────────────────────────────────────────────

export type ChatToHostMessage =
  | { type: 'ready' }
  | { type: 'listModels' }
  | { type: 'listSessions' }
  | { type: 'createSession'; model: string; topic?: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'getSession'; sessionId: string }
  | { type: 'sendMessage'; sessionId: string; content: string; model?: string }
  | { type: 'cancelStream' }
  | { type: 'approveToolCall'; requestId: string; decision: 'allow' | 'deny' | 'abort' };

export type HostToChatMessage =
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'sessionCreated'; session: SessionDetail }
  | { type: 'sessionLoaded'; session: SessionDetail }
  | { type: 'streamChunk'; text: string }
  | { type: 'streamDone'; finishReason: string }
  | { type: 'toolCall'; id: string; name: string; args: string }
  | { type: 'toolResult'; callId: string; name: string; content: string; isError: boolean }
  | { type: 'toolApprovalRequest'; requestId: string; toolName: string; promptText: string }
  | { type: 'error'; message: string; context?: string };

// ─── Shared view types (serializable subsets of proto types) ────────

export interface ProviderInfo {
  id: string;
  engine: string;
  configured: boolean;
  healthy: boolean;
  requiresKey: boolean;
  baseUrl?: string;
  modelCount: number;
}

export interface ProviderTemplateInfo {
  id: string;
  displayName: string;
  engine: string;
  requiresKey: boolean;
  defaultBaseUrl?: string;
  defaultEnvVar?: string;
}

export interface EngineInfo {
  id: string;
  displayName?: string;
  requiresKey: boolean;
  defaultBaseUrl?: string;
  defaultEnvVar?: string;
}

export interface SecretInfoView {
  key: string;
  store: string;
  hasValue: boolean;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  engine: string;
}

export interface SessionInfo {
  id: string;
  model: string;
  topic: string;
  messageCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionDetail extends SessionInfo {
  messages: MessageInfo[];
}

export interface MessageInfo {
  role: string;
  content: string;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}
