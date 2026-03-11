/**
 * Configuration loader
 * 
 * Loads and saves YAML configuration from:
 * - User level:      <configDir>/config.yaml   (platform-aware via paths.ts)
 * - Workspace level:  <workspace>/.config/abbenay/config.yaml
 * 
 * The config uses "virtual" provider and model names as primary keys.
 * See the plan's Terminology section for virtual vs actual distinction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  getUserConfigPath as _getUserConfigPath,
  getWorkspaceConfigPath as _getWorkspaceConfigPath,
} from './paths.js';

// ── Name validation ────────────────────────────────────────────────────

/**
 * Regex for virtual provider and model names.
 * Lowercase alphanumeric, dots, hyphens, underscores. No slashes, no spaces.
 * Engine model IDs from discovery (which may contain slashes) are exempt.
 */
const VIRTUAL_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Validate a virtual name (provider or model).
 * Returns true if valid, false otherwise.
 * Engine model IDs (containing slashes) are NOT validated by this — they pass through.
 */
export function isValidVirtualName(name: string): boolean {
  return VIRTUAL_NAME_REGEX.test(name);
}

// ── Config interfaces ──────────────────────────────────────────────────

/**
 * Per-model config entry.
 * The YAML key is the virtual model name (= unique ID within its provider).
 * 
 * - Key with no `model_id` → the key IS the engine model ID (novice path)
 * - Key with `model_id` → the key is a virtual name, model_id is the actual engine model
 * - `{}` = enabled with all default params
 */
export interface ModelConfig {
  /** Actual engine model ID — required when the key is a virtual name */
  model_id?: string;
  /** Named policy to apply as behavioral defaults for this model */
  policy?: string;
  /** System prompt text (prepended to or replaces request system message) */
  system_prompt?: string;
  /** How to combine config system_prompt with request: "prepend" (default) or "replace" */
  system_prompt_mode?: 'prepend' | 'replace';
  /** Sampling temperature (0.0 - 2.0) */
  temperature?: number;
  /** Nucleus sampling (0.0 - 1.0) */
  top_p?: number;
  /** Top-k sampling (integer) */
  top_k?: number;
  /** Maximum output tokens */
  max_tokens?: number;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Per-provider config entry.
 * The YAML key is the virtual provider name (= unique ID).
 * 
 * A provider points to an engine (actual API implementation) and holds
 * credentials, base URL, and a map of enabled models with their params.
 */
export interface ProviderConfig {
  /** Actual engine type: "openrouter", "openai", "anthropic", etc. */
  engine: string;
  /** Keychain key name for API key */
  api_key_keychain_name?: string;
  /** Environment variable name for API key */
  api_key_env_var_name?: string;
  /** Custom API base URL (falls back to engine default) */
  base_url?: string;
  /** Enabled models: key = virtual model name, value = model config */
  models?: Record<string, ModelConfig>;
}

/**
 * MCP server connection configuration.
 * Defines an external MCP server the daemon can connect to for tool aggregation.
 */
export interface McpServerConfig {
  /** Command to run for stdio transport */
  command?: string;
  /** Arguments for the command */
  args?: string[];
  /** URL for HTTP/SSE transport */
  url?: string;
  /** Transport type */
  transport: 'stdio' | 'http';
  /** Whether this server is enabled */
  enabled: boolean;
  /** HTTP headers (for authenticated endpoints) */
  headers?: Record<string, string>;
  /** Environment variables to set for stdio subprocess */
  env?: Record<string, string>;
  /** Max tool response size in bytes (default 102400 = 100KB) */
  max_response_size?: number;
}

/**
 * Full configuration file structure.
 * Keys in `providers` are virtual provider names (user-defined IDs).
 */
export interface ConfigFile {
  providers?: Record<string, ProviderConfig>;
  /** External MCP servers for tool aggregation */
  mcp_servers?: Record<string, McpServerConfig>;
  /** Tool execution policy (approval tiers, disabled tools, aliases) */
  tool_policy?: import('./tool-registry.js').ToolPolicyConfig;
}

// ── Path helpers ───────────────────────────────────────────────────────

/**
 * Get user config path (platform-aware via paths.ts)
 */
export function getUserConfigPath(): string {
  return _getUserConfigPath();
}

/**
 * Get workspace config path: <workspace>/.config/abbenay/config.yaml
 */
export function getWorkspaceConfigPath(workspacePath: string): string {
  return _getWorkspaceConfigPath(workspacePath);
}

// ── Load / Save ────────────────────────────────────────────────────────

/**
 * Load configuration from a file.
 * Handles both new schema (engine + models map) and old schema (enabled_models array).
 */
export function loadConfigFromPath(configPath: string): ConfigFile | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = yaml.load(content) as any;
    if (!raw) return { providers: {} };
    
    // Reject old Rust-era array format — user must delete and reconfigure
    if (Array.isArray(raw.providers)) {
      console.warn(`[Config] Ignoring old array-based config at ${configPath}. Delete it and reconfigure.`);
      return { providers: {} };
    }
    
    const config = raw as ConfigFile;
    
    // Migrate old schema if needed
    if (config.providers) {
      for (const [provId, provCfg] of Object.entries(config.providers)) {
        migrateProviderConfig(provId, provCfg as any);
      }
    }
    
    return config || { providers: {} };
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    return null;
  }
}

/**
 * Migrate a provider config from old schema to new schema in-place.
 * Old: { api_base, enabled_models: string[] }
 * New: { engine, base_url, models: Record<string, ModelConfig> }
 * 
 * If no `engine` field is present, assumes the provider key IS the engine ID
 * (backward compat with the old 1:1 mapping).
 */
function migrateProviderConfig(provId: string, cfg: any): void {
  // If already new format (has engine field), just rename api_base → base_url
  if (cfg.engine) {
    if (cfg.api_base && !cfg.base_url) {
      cfg.base_url = cfg.api_base;
      delete cfg.api_base;
    }
    return;
  }
  
  // Old format: provider key = engine ID
  cfg.engine = provId;
  
  // Rename api_base → base_url
  if (cfg.api_base) {
    cfg.base_url = cfg.api_base;
    delete cfg.api_base;
  }
  
  // Convert enabled_models: string[] → models: Record<string, ModelConfig>
  if (cfg.enabled_models && Array.isArray(cfg.enabled_models)) {
    const models: Record<string, ModelConfig> = {};
    for (const modelId of cfg.enabled_models) {
      models[modelId] = {}; // Default params — key IS the engine model ID
    }
    cfg.models = models;
    delete cfg.enabled_models;
  }
}

/**
 * Save configuration to a file
 */
export function saveConfigToPath(configPath: string, config: ConfigFile): void {
  // Ensure directory exists
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });
  
  fs.writeFileSync(configPath, content, { mode: 0o600 });
}

/**
 * Load user-level configuration
 */
export function loadConfig(): ConfigFile {
  const userConfig = loadConfigFromPath(getUserConfigPath());
  return userConfig || { providers: {} };
}

/**
 * Save user-level configuration
 */
export function saveConfig(config: ConfigFile): void {
  saveConfigToPath(getUserConfigPath(), config);
}

/**
 * Load workspace-level configuration
 */
export function loadWorkspaceConfig(workspacePath: string): ConfigFile | null {
  return loadConfigFromPath(getWorkspaceConfigPath(workspacePath));
}

/**
 * Save workspace-level configuration
 */
export function saveWorkspaceConfig(workspacePath: string, config: ConfigFile): void {
  saveConfigToPath(getWorkspaceConfigPath(workspacePath), config);
}

// ── Merge logic ────────────────────────────────────────────────────────

/**
 * Merge configurations (workspace overrides user at provider level).
 * If a workspace defines a provider, it completely replaces that provider's config.
 */
export function mergeConfigs(userConfig: ConfigFile, workspaceConfig: ConfigFile | null): ConfigFile {
  if (!workspaceConfig) {
    return userConfig;
  }
  
  const merged: ConfigFile = {
    providers: { ...userConfig.providers },
  };
  
  // Workspace providers completely replace user providers (provider-level replacement)
  if (workspaceConfig.providers) {
    for (const [providerId, providerConfig] of Object.entries(workspaceConfig.providers)) {
      merged.providers![providerId] = providerConfig;
    }
  }
  
  // Merge mcp_servers (workspace overrides user at server-level)
  if (userConfig.mcp_servers || workspaceConfig.mcp_servers) {
    merged.mcp_servers = { ...userConfig.mcp_servers, ...workspaceConfig.mcp_servers };
  }
  
  // Merge tool_policy (workspace arrays append to user arrays)
  if (userConfig.tool_policy || workspaceConfig.tool_policy) {
    const up = userConfig.tool_policy || {};
    const wp = workspaceConfig.tool_policy || {};
    merged.tool_policy = {
      max_tool_iterations: wp.max_tool_iterations ?? up.max_tool_iterations,
      auto_approve: [...(up.auto_approve || []), ...(wp.auto_approve || [])],
      require_approval: [...(up.require_approval || []), ...(wp.require_approval || [])],
      disabled_tools: [...(up.disabled_tools || []), ...(wp.disabled_tools || [])],
      aliases: { ...up.aliases, ...wp.aliases },
    };
  }
  
  return merged;
}

/**
 * Merge user config with multiple workspace configs.
 * 
 * Provider-level replacement: if ANY workspace defines a provider, that
 * provider's config completely replaces the user-level config for it.
 * 
 * For multi-root workspaces (multiple workspace paths), models from the
 * same provider across workspaces are unioned — but the user config's
 * models for that provider are NOT included.
 * 
 * Providers not mentioned by any workspace are kept from the user config.
 * If workspacePaths is empty, returns the user config as-is.
 */
export function mergeMultipleWorkspaceConfigs(workspacePaths: string[]): ConfigFile {
  const userConfig = loadConfig();
  
  if (workspacePaths.length === 0) {
    return userConfig;
  }
  
  const merged: ConfigFile = {
    providers: { ...userConfig.providers },
  };
  
  // Track which providers are defined by workspaces, and their models
  // (unioned across workspaces, but NOT seeded from user config)
  const wsProviderModels: Record<string, Record<string, ModelConfig>> = {};
  
  // Overlay each workspace config — provider-level replacement
  for (const wsPath of workspacePaths) {
    const wsConfig = loadWorkspaceConfig(wsPath);
    if (!wsConfig?.providers) continue;
    
    for (const [providerId, wsCfg] of Object.entries(wsConfig.providers)) {
      if (!(providerId in wsProviderModels)) {
        // First workspace to define this provider replaces the user config entirely
        merged.providers![providerId] = { ...wsCfg };
        wsProviderModels[providerId] = { ...(wsCfg.models || {}) };
      } else {
        // Subsequent workspaces: overlay fields and union models
        const { models: wsModels, ...wsRest } = wsCfg;
        merged.providers![providerId] = {
          ...merged.providers![providerId],
          ...wsRest,
        };
        if (wsModels) {
          for (const [modelName, modelCfg] of Object.entries(wsModels)) {
            wsProviderModels[providerId][modelName] = modelCfg;
          }
        }
      }
    }
  }
  
  // Write final models back for workspace-defined providers
  for (const [providerId, models] of Object.entries(wsProviderModels)) {
    if (merged.providers![providerId]) {
      merged.providers![providerId].models =
        Object.keys(models).length > 0 ? models : undefined;
    }
  }
  
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Get provider configuration (merged user + workspace).
 */
export function getProviderConfig(providerId: string, workspacePath?: string): ProviderConfig | null {
  const userConfig = loadConfig();
  const workspaceConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
  const merged = mergeConfigs(userConfig, workspaceConfig);
  
  return merged.providers?.[providerId] || null;
}

/**
 * Get all configured provider IDs (merged user + workspace).
 */
export function getConfiguredProviders(workspacePath?: string): string[] {
  const userConfig = loadConfig();
  const workspaceConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
  const merged = mergeConfigs(userConfig, workspaceConfig);
  
  return Object.keys(merged.providers || {});
}

/**
 * Resolve the engine model ID for a model config entry.
 * If the entry has model_id, use it. Otherwise, the key itself is the engine model ID.
 */
export function resolveEngineModelId(modelName: string, modelConfig: ModelConfig): string {
  return modelConfig.model_id || modelName;
}

/**
 * Get enabled model names for a provider from its config.
 * Returns the keys of the models map (virtual or raw names).
 */
export function getEnabledModelNames(providerConfig: ProviderConfig): string[] {
  if (!providerConfig.models) return [];
  return Object.keys(providerConfig.models);
}
