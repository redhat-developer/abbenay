/**
 * @abbenay/core — Public API
 *
 * Lightweight library for agent developers, web developers, and custom apps.
 * Provides LLM engine abstraction, streaming chat, model discovery,
 * configuration management, and a pluggable secret store.
 *
 * Zero transport dependencies — no gRPC, no Express, no CLI.
 *
 * Quick start:
 *   import { CoreState, MemorySecretStore } from '@abbenay/core';
 *   const state = new CoreState({ secretStore: new MemorySecretStore() });
 *   const models = await state.listModels();
 *
 * AI SDK provider packages are optional peer dependencies.
 * Install only the engines you use:
 *   npm install @ai-sdk/openai        # for OpenAI
 *   npm install @ai-sdk/anthropic     # for Anthropic
 *   npm install @ai-sdk/google        # for Gemini
 *
 * @module @abbenay/core
 */

// ─── Primary API ────────────────────────────────────────────────────────
// These are the stable, documented entry points for library consumers.

/** Core state manager — the main entry point for @abbenay/core */
export { CoreState } from './state.js';
export type { CoreStateOptions, AddProviderOptions } from './state.js';

/** Secret store — inject your own or use the built-in MemorySecretStore */
export { MemorySecretStore } from './secrets.js';
export type { SecretStore } from './secrets.js';

// ─── Types: Providers & Models ──────────────────────────────────────────

/** Virtual provider info returned by CoreState.listProviders() */
export type { ProviderInfo } from './state.js';

/** Virtual model info returned by CoreState.listModels() */
export type { ModelInfo } from './state.js';

/** Engine metadata (the fixed set of supported LLM backends) */
export type { EngineInfo } from './engines.js';

/** Model info from engine discovery (CoreState.discoverModels()) */
export type { DiscoveredModel } from './engines.js';

/** Template for "Add Provider" wizards */
export type { ProviderTemplate } from './engines.js';

// ─── Types: Chat ────────────────────────────────────────────────────────

/** Streamed chat chunk yielded by CoreState.chat() */
export type { ChatChunk } from './engines.js';

/** Per-request chat parameters (temperature, maxTokens, etc.) */
export type { ChatParams } from './engines.js';

/** Tool behavior options for chat() */
export type { ChatToolOptions } from './state.js';

/** Tool definition passed to the LLM */
export type { ToolDefinition } from './engines.js';

/** Callback to execute a tool call */
export type { ToolExecutor } from './engines.js';

/** Callback for tool approval before execution */
export type { ToolValidationCallback } from './engines.js';

// ─── Types: Configuration ───────────────────────────────────────────────

/** Top-level config file structure (mirrors YAML) */
export type { ConfigFile } from './config.js';

/** Per-provider configuration block */
export type { ProviderConfig } from './config.js';

/** Per-model configuration block */
export type { ModelConfig } from './config.js';

/** MCP server connection configuration */
export type { McpServerConfig } from './config.js';

// ─── Types: Policies ────────────────────────────────────────────────────

/** Named behavioral policy assigned to a model */
export type { PolicyConfig, PolicyInfo, PolicySampling, PolicyOutput, PolicyContext, PolicyTool, PolicyReliability } from './policies.js';

// ─── Tool Registry ──────────────────────────────────────────────────────

/** Tool collection, namespacing, and policy filtering */
export { ToolRegistry } from './tool-registry.js';

/** Tool registry types */
export type {
  RegisteredTool,
  ToolRegistrationInput,
  ToolPolicyConfig,
  ToolSourceType,
} from './tool-registry.js';

/** Tool policy pattern matching */
export { matchesAnyPattern } from './tool-registry.js';

// ─── Engine Listing ─────────────────────────────────────────────────────

/** Get all available engines (the fixed set of LLM API implementations) */
export { getEngines, getEngine, getProviderTemplates } from './engines.js';

// ─── Config I/O ─────────────────────────────────────────────────────────

/** Load/save user and workspace configuration */
export { loadConfig, saveConfig, loadWorkspaceConfig, saveWorkspaceConfig } from './config.js';

/** Get default config file paths */
export { getUserConfigPath, getWorkspaceConfigPath } from './config.js';

// ─── Advanced / Internal ────────────────────────────────────────────────
// These are exported for power users who need low-level access.
// They are NOT part of the stable API contract and may change.

/** Low-level: stream chat directly against an engine (bypasses CoreState) */
export { streamChat } from './engines.js';

/** Low-level: fetch models directly from an engine API */
export { fetchModels } from './engines.js';

/** Config utilities for custom config pipelines */
export {
  loadConfigFromPath,
  saveConfigToPath,
  mergeConfigs,
  mergeMultipleWorkspaceConfigs,
  getProviderConfig,
  getConfiguredProviders,
  resolveEngineModelId,
  getEnabledModelNames,
  isValidVirtualName,
} from './config.js';

/** Policy management */
export {
  BUILTIN_POLICIES,
  BUILTIN_POLICY_NAMES,
  loadCustomPolicies,
  saveCustomPolicies,
  resolvePolicy,
  flattenPolicy,
  listAllPolicies,
  getUserPoliciesPath,
} from './policies.js';

/** Shared constants */
export { DEFAULT_WEB_PORT } from './constants.js';

/** Platform-aware path utilities */
export {
  getRuntimeDir,
  getConfigDir,
  getWorkspaceConfigDir,
  getSocketPath,
  getPidPath,
} from './paths.js';

/** Mock engine for testing (deterministic, no API key needed) */
export { mockStreamChat, getMockModels } from './mock.js';
export type { MockModelInfo } from './mock.js';
