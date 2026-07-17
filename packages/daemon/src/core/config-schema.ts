/**
 * Zod schemas for Abbenay configuration shapes.
 *
 * Shared by the HTTP API (request validation) and any core callers that need
 * typed config parsing. Keep in sync with the interfaces in config.ts /
 * policies.ts / tool-registry.ts.
 */

import { z } from 'zod';
import { isValidVirtualName } from './config.js';

/** Virtual provider/model/policy name (lowercase alphanumeric + ._-). */
export const VirtualNameSchema = z
  .string()
  .min(1)
  .refine(isValidVirtualName, {
    message: 'must be lowercase alphanumeric with dots, hyphens, or underscores',
  });

export const ModelConfigSchema = z
  .object({
    model_id: z.string().min(1).optional(),
    policy: z.string().min(1).optional(),
    system_prompt: z.string().optional(),
    system_prompt_mode: z.enum(['prepend', 'replace']).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().nonnegative().optional(),
    max_tokens: z.number().int().positive().optional(),
    timeout: z.number().positive().optional(),
  })
  .strict();

export const ProviderConfigSchema = z
  .object({
    engine: z.string().min(1),
    api_key_keychain_name: z.string().min(1).optional(),
    api_key_env_var_name: z.string().min(1).optional(),
    base_url: z.string().min(1).optional(),
    models: z.record(z.string(), ModelConfigSchema).optional(),
  })
  .strict();

export const McpServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    transport: z.enum(['stdio', 'http', 'sse']),
    enabled: z.boolean(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    max_response_size: z.number().int().positive().optional(),
  })
  .strict();

export const ToolPolicyConfigSchema = z
  .object({
    max_tool_iterations: z.number().int().positive().optional(),
    auto_approve: z.array(z.string()).optional(),
    require_approval: z.array(z.string()).optional(),
    disabled_tools: z.array(z.string()).optional(),
    aliases: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ConsumerCapabilitiesSchema = z
  .object({
    inline_policy: z.boolean().optional(),
    mcp_register: z.boolean().optional(),
  })
  .strict();

export const ConsumerConfigSchema = z
  .object({
    token_env: z.string().min(1).optional(),
    token_keychain: z.string().min(1).optional(),
    capabilities: ConsumerCapabilitiesSchema,
  })
  .strict();

export const ServerConfigSchema = z
  .object({
    api_token: z.string().min(1).optional(),
    api_token_env: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    cors_origins: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Full config.yaml shape. Unknown top-level keys are rejected (`.strict()`)
 * to block field injection into saved config files.
 */
export const ConfigFileSchema = z
  .object({
    providers: z.record(z.string(), ProviderConfigSchema).optional(),
    mcp_servers: z.record(z.string(), McpServerConfigSchema).optional(),
    tool_policy: ToolPolicyConfigSchema.optional(),
    consumers: z.record(z.string(), ConsumerConfigSchema).optional(),
    server: ServerConfigSchema.optional(),
  })
  .strict();

export type ConfigFileParsed = z.infer<typeof ConfigFileSchema>;

// ── Policy config (policies.yaml entries) ───────────────────────────────

export const PolicyConfigSchema = z
  .object({
    sampling: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        top_k: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    output: z
      .object({
        max_tokens: z.number().int().positive().optional(),
        reserved_output_tokens: z.number().int().nonnegative().optional(),
        format: z.enum(['text', 'json_only', 'markdown']).optional(),
        system_prompt_snippet: z.string().optional(),
        system_prompt_mode: z.enum(['prepend', 'append', 'replace']).optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({
        context_threshold: z.number().optional(),
        compression_strategy: z.enum(['none', 'truncate', 'rolling_summary']).optional(),
      })
      .strict()
      .optional(),
    tool: z
      .object({
        max_tool_iterations: z.number().int().positive().optional(),
        tool_mode: z.enum(['auto', 'ask', 'none']).optional(),
      })
      .strict()
      .optional(),
    reliability: z
      .object({
        retry_on_invalid_json: z.boolean().optional(),
        timeout: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PolicyConfigParsed = z.infer<typeof PolicyConfigSchema>;

/**
 * Parse and validate a ConfigFile-shaped value.
 * Returns a structured result (never throws).
 */
export function parseConfigFile(raw: unknown):
  | { success: true; data: ConfigFileParsed }
  | { success: false; error: z.ZodError } {
  const result = ConfigFileSchema.safeParse(raw);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true, data: result.data };
}
