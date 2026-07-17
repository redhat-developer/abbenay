/**
 * Zod request-body schemas for every mutating HTTP web API route.
 *
 * Config shapes are shared with `@abbenay/core` via config-schema.ts.
 * Route schemas use `.strict()` so unexpected fields are rejected before
 * business logic runs.
 */

import { z } from 'zod';
import {
  ConfigFileSchema,
  PolicyConfigSchema,
  VirtualNameSchema,
} from '../../core/config-schema.js';

/** Empty / ignored body (routes that do not consume JSON fields). */
export const EmptyBodySchema = z.preprocess(
  (v) => (v === undefined || v === null ? {} : v),
  z.object({}).strict(),
);

// ── Auth ────────────────────────────────────────────────────────────────

export const LoginBodySchema = z
  .object({
    token: z.string().optional(),
    api_token: z.string().optional(),
  })
  .strict();

// ── Config ──────────────────────────────────────────────────────────────

export const PostConfigBodySchema = z
  .object({
    /** Defaults to user-level config when omitted. */
    location: z.string().min(1).optional(),
    config: ConfigFileSchema,
  })
  .strict();

// ── Secrets ─────────────────────────────────────────────────────────────

export const PostSecretByKeyBodySchema = z
  .object({
    value: z.string().min(1),
  })
  .strict();

export const PostSecretBodySchema = z
  .object({
    key: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

// ── Chat ────────────────────────────────────────────────────────────────

const ChatMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.union([z.string(), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .strict();

const ChatToolDefSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    input_schema: z.union([z.string(), z.record(z.unknown())]).optional(),
  })
  .strict();

export const PostChatBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).min(1),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    max_tokens: z.number().optional(),
    timeout: z.number().optional(),
    tools: z.array(ChatToolDefSchema).optional(),
    tool_mode: z.enum(['auto', 'ask', 'none', 'passthrough']).optional(),
  })
  .strict();

export const PostChatApproveBodySchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum(['allow', 'deny', 'abort']),
  })
  .strict();

// ── Provider ────────────────────────────────────────────────────────────

export const PostProviderConfigureBodySchema = z
  .object({
    engine: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    envVarName: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
    target: z.enum(['user', 'workspace']).optional(),
    workspacePath: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.target === 'workspace' && !data.workspacePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspacePath is required when target is "workspace"',
        path: ['workspacePath'],
      });
    }
  });

// ── Policies ────────────────────────────────────────────────────────────

export const PostPolicyBodySchema = z
  .object({
    name: VirtualNameSchema,
    config: PolicyConfigSchema,
  })
  .strict();

// ── Sessions ────────────────────────────────────────────────────────────

export const PostSessionBodySchema = z
  .object({
    model: z.string().min(1),
    title: z.string().optional(),
    policy: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const PostSessionChatBodySchema = z
  .object({
    message: z
      .object({
        role: z.string().min(1).optional(),
        content: z.string().min(1),
      })
      .strict(),
  })
  .strict();

// ── Discover models (DR-035: keys via header/body, never query) ──────────

export const DiscoverModelsBodySchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
  })
  .strict();

// ── MCP connection consent + tool approval (DR-033 / DR-034) ────────────

export const PostMcpConnectionDecisionBodySchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    remember: z.boolean().optional(),
  })
  .strict();

export const PostMcpApprovalBodySchema = z
  .object({
    decision: z.enum(['allow', 'deny', 'abort']),
  })
  .strict();

// ── OpenAI-compatible ───────────────────────────────────────────────────

const OpenAIChatMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.union([z.string(), z.null(), z.array(z.unknown())]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.unknown().optional(),
  })
  .passthrough();

export const PostOpenAIChatCompletionsBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIChatMessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().optional(),
    max_completion_tokens: z.number().optional(),
    // DR-032: optional client tools for opt-in passthrough (validated/mapped in openai-compat).
    tools: z.array(z.unknown()).optional(),
  })
  .strict();

export type PostConfigBody = z.infer<typeof PostConfigBodySchema>;
export type PostChatBody = z.infer<typeof PostChatBodySchema>;
export type PostChatApproveBody = z.infer<typeof PostChatApproveBodySchema>;
export type PostProviderConfigureBody = z.infer<typeof PostProviderConfigureBodySchema>;
export type PostPolicyBody = z.infer<typeof PostPolicyBodySchema>;
export type PostSessionBody = z.infer<typeof PostSessionBodySchema>;
export type PostSessionChatBody = z.infer<typeof PostSessionChatBodySchema>;
export type DiscoverModelsBody = z.infer<typeof DiscoverModelsBodySchema>;
export type PostMcpConnectionDecisionBody = z.infer<typeof PostMcpConnectionDecisionBodySchema>;
export type PostMcpApprovalBody = z.infer<typeof PostMcpApprovalBodySchema>;
export type PostOpenAIChatCompletionsBody = z.infer<typeof PostOpenAIChatCompletionsBodySchema>;
