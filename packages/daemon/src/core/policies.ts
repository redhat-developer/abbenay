/**
 * Policy system
 *
 * Policies are named bundles of behavioral defaults (sampling, output, reliability)
 * that can be assigned to virtual models. A model references a single policy by name;
 * the policy's fields act as defaults that the model's explicit config can override.
 *
 * Built-in policies are hardcoded and immutable.
 * Custom policies are user-defined in <configDir>/policies.yaml (user-level only).
 *
 * Resolution order (later wins):
 *   Engine defaults  <--  Policy defaults  <--  Explicit ModelConfig  <--  Request params
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
import { getConfigDir } from './paths.js';
import type { ModelConfig } from './config.js';

// ── PolicyConfig interface ──────────────────────────────────────────────

export interface PolicySampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface PolicyOutput {
  max_tokens?: number;
  reserved_output_tokens?: number;
  format?: 'text' | 'json_only' | 'markdown';
  system_prompt_snippet?: string;
  /** How to combine snippet with existing system prompt. Default: 'prepend'. */
  system_prompt_mode?: 'prepend' | 'append' | 'replace';
}

export interface PolicyContext {
  context_threshold?: number;
  compression_strategy?: 'none' | 'truncate' | 'rolling_summary';
}

export interface PolicyTool {
  max_tool_iterations?: number;
  tool_mode?: 'auto' | 'ask' | 'none';
}

export interface PolicyReliability {
  retry_on_invalid_json?: boolean;
  timeout?: number;
}

export interface PolicyConfig {
  sampling?: PolicySampling;
  output?: PolicyOutput;
  context?: PolicyContext;
  tool?: PolicyTool;
  reliability?: PolicyReliability;
}

/** Policy with metadata for API responses */
export interface PolicyInfo {
  name: string;
  builtin: boolean;
  config: PolicyConfig;
}

// ── Built-in policies (immutable) ───────────────────────────────────────

export const BUILTIN_POLICIES: Record<string, PolicyConfig> = {
  precise: {
    sampling: { temperature: 0.15, top_p: 0.3 },
    output: {
      max_tokens: 2048,
      system_prompt_snippet: 'Be concise and factual. Do not guess or fabricate information.',
    },
  },
  balanced: {
    sampling: { temperature: 0.5, top_p: 0.9 },
    output: { max_tokens: 4096 },
  },
  creative: {
    sampling: { temperature: 0.9, top_p: 1.0 },
    output: { max_tokens: 8192 },
  },
  coder: {
    sampling: { temperature: 0.2, top_p: 0.5 },
    output: {
      max_tokens: 4096,
      system_prompt_snippet:
        'Always provide complete, runnable code. Avoid pseudocode unless requested. ' +
        'Prefer standard libraries. Include commands to run and test.',
    },
  },
  json_strict: {
    sampling: { temperature: 0.2, top_p: 0.5 },
    output: {
      format: 'json_only',
      max_tokens: 2048,
      system_prompt_snippet: 'Respond ONLY with valid JSON. No markdown, no prose, no explanation.',
    },
    reliability: { retry_on_invalid_json: true },
  },
  long_context_chat: {
    output: {
      max_tokens: 4096,
      system_prompt_snippet: 'Avoid rehashing previous points. Be concise in follow-ups.',
    },
  },
};

export const BUILTIN_POLICY_NAMES = Object.keys(BUILTIN_POLICIES);

// ── Path helper ─────────────────────────────────────────────────────────

export function getUserPoliciesPath(): string {
  return path.join(getConfigDir(), 'policies.yaml');
}

// ── Load / Save custom policies ─────────────────────────────────────────

/**
 * Load custom (user-defined) policies from policies.yaml.
 * Returns an empty record if the file doesn't exist or is malformed.
 */
export function loadCustomPolicies(): Record<string, PolicyConfig> {
  const policiesPath = getUserPoliciesPath();
  if (!fs.existsSync(policiesPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(policiesPath, 'utf-8');
    const raw = yaml.load(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    return raw as Record<string, PolicyConfig>;
  } catch (error) {
    console.error(`[Policies] Failed to load custom policies from ${policiesPath}:`, error);
    return {};
  }
}

/**
 * Save custom policies to policies.yaml (atomic write via temp + rename).
 */
export function saveCustomPolicies(policies: Record<string, PolicyConfig>): void {
  const policiesPath = getUserPoliciesPath();
  const dir = path.dirname(policiesPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content = yaml.dump(policies, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  const tmpPath = policiesPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, policiesPath);
  } catch (error) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

// ── Resolution ──────────────────────────────────────────────────────────

let _unenforcedWarned = false;

/**
 * Resolve a policy by name. Checks custom policies first, then built-ins.
 * Returns null if the policy name is not found.
 */
export function resolvePolicy(name: string): PolicyConfig | null {
  const custom = loadCustomPolicies();
  if (custom[name]) {
    warnUnenforcedFields(name, custom[name]);
    return custom[name];
  }
  if (BUILTIN_POLICIES[name]) {
    return BUILTIN_POLICIES[name];
  }
  console.warn(`[Policies] Unknown policy "${name}" — ignoring.`);
  return null;
}

/**
 * Log a warning (once per process lifetime) if a policy uses Phase 2 fields
 * that aren't enforced yet.
 */
function warnUnenforcedFields(name: string, policy: PolicyConfig): void {
  if (_unenforcedWarned) return;

  const unenforced: string[] = [];
  if (policy.output?.reserved_output_tokens != null) unenforced.push('output.reserved_output_tokens');
  if (policy.context) unenforced.push('context.*');

  if (unenforced.length > 0) {
    console.warn(
      `[Policies] Policy "${name}" uses fields not yet enforced: ${unenforced.join(', ')}. ` +
      `These will be ignored until a future release.`
    );
    _unenforcedWarned = true;
  }
}

// ── Flattening ──────────────────────────────────────────────────────────

/**
 * Result of flattening a policy into model-config-compatible fields.
 * Includes the extra policy-specific fields that need special handling.
 */
export interface FlattenedPolicy {
  /** Standard ModelConfig-compatible sampling/output fields */
  params: Partial<Pick<ModelConfig, 'temperature' | 'top_p' | 'top_k' | 'max_tokens' | 'timeout'>>;
  /** System prompt snippet from the policy */
  systemPromptSnippet?: string;
  /** How to combine snippet with model's system_prompt */
  systemPromptMode?: 'prepend' | 'append' | 'replace';
  /** Output format constraint */
  outputFormat?: 'text' | 'json_only' | 'markdown';
  /** Whether to retry on invalid JSON */
  retryOnInvalidJson?: boolean;
  /** Tool mode override from policy */
  toolMode?: 'auto' | 'ask' | 'none';
  /** Max tool execution rounds from policy */
  maxToolIterations?: number;
}

/**
 * Flatten a PolicyConfig into model-config-compatible fields.
 * This is a pure transformation — no persistence, no side effects.
 */
export function flattenPolicy(policy: PolicyConfig): FlattenedPolicy {
  const params: FlattenedPolicy['params'] = {};

  if (policy.sampling?.temperature != null) params.temperature = policy.sampling.temperature;
  if (policy.sampling?.top_p != null) params.top_p = policy.sampling.top_p;
  if (policy.sampling?.top_k != null) params.top_k = policy.sampling.top_k;
  if (policy.output?.max_tokens != null) params.max_tokens = policy.output.max_tokens;
  if (policy.reliability?.timeout != null) params.timeout = policy.reliability.timeout;

  return {
    params,
    systemPromptSnippet: policy.output?.system_prompt_snippet,
    systemPromptMode: policy.output?.system_prompt_mode || 'prepend',
    outputFormat: policy.output?.format,
    retryOnInvalidJson: policy.reliability?.retry_on_invalid_json,
    toolMode: policy.tool?.tool_mode,
    maxToolIterations: policy.tool?.max_tool_iterations,
  };
}

/**
 * List all policies (built-in + custom) with metadata.
 */
export function listAllPolicies(): PolicyInfo[] {
  const result: PolicyInfo[] = [];

  for (const [name, config] of Object.entries(BUILTIN_POLICIES)) {
    result.push({ name, builtin: true, config });
  }

  const custom = loadCustomPolicies();
  for (const [name, config] of Object.entries(custom)) {
    if (BUILTIN_POLICIES[name]) continue; // custom can't shadow built-ins
    result.push({ name, builtin: false, config });
  }

  return result;
}
