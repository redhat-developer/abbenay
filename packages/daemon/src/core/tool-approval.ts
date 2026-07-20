/**
 * Shared tool approval policy — used by chat (streamChat) and MCP HTTP (/mcp).
 *
 * Precedence (secure-by-default, DR-019 / DR-033):
 *   disabled_tools → deny
 *   require_approval → ask (onApprovalNeeded)
 *   auto_approve → allow
 *   default → ask (onApprovalNeeded)
 *
 * Chat and MCP MUST use this helper so there is no execution path that
 * bypasses policy.
 */

import * as crypto from 'node:crypto';
import type { ToolValidationCallback } from './engines.js';
import { matchesAnyPattern, type ToolPolicyConfig, type ToolRegistry } from './tool-registry.js';

export type ApprovalDecision = 'allow' | 'deny' | 'abort';

/**
 * Transport-specific callback when a tool needs explicit user consent.
 * Web chat/MCP block until REST approve; CLI prompts via readline.
 */
export type OnToolApprovalNeeded = (
  requestId: string,
  toolName: string,
  args: unknown,
  namespacedName?: string,
) => Promise<ApprovalDecision>;

/**
 * Classify a tool against policy without prompting.
 * Useful for list filtering and diagnostics.
 */
export type ToolPolicyTier = 'disabled' | 'require_approval' | 'auto_approve' | 'default_ask';

export function classifyToolPolicy(
  namespacedName: string,
  policy: ToolPolicyConfig | undefined,
): ToolPolicyTier {
  if (matchesAnyPattern(policy?.disabled_tools, namespacedName)) {
    return 'disabled';
  }
  if (matchesAnyPattern(policy?.require_approval, namespacedName)) {
    return 'require_approval';
  }
  if (matchesAnyPattern(policy?.auto_approve, namespacedName)) {
    return 'auto_approve';
  }
  return 'default_ask';
}

/**
 * Build the shared tool validator used by chat engines and MCP HTTP.
 *
 * @param registry - Tool registry for namespaced name resolution
 * @param policy - Current tool_policy from config (may be undefined)
 * @param onApprovalNeeded - Required for ask tiers; if omitted, ask tiers deny (fail-closed)
 */
export function createToolValidator(
  registry: ToolRegistry,
  policy: ToolPolicyConfig | undefined,
  onApprovalNeeded?: OnToolApprovalNeeded,
): ToolValidationCallback {
  const requirePatterns = policy?.require_approval;
  const autoPatterns = policy?.auto_approve;
  const disabledPatterns = policy?.disabled_tools;

  return async (toolName: string, args: unknown): Promise<ApprovalDecision> => {
    const resolved = registry.resolve(toolName);
    const nsName = resolved?.namespacedName || toolName;

    if (matchesAnyPattern(disabledPatterns, nsName)) {
      return 'deny';
    }

    if (matchesAnyPattern(requirePatterns, nsName)) {
      if (!onApprovalNeeded) return 'deny';
      const requestId = crypto.randomUUID();
      return onApprovalNeeded(requestId, toolName, args, nsName);
    }

    if (matchesAnyPattern(autoPatterns, nsName)) {
      return 'allow';
    }

    // Default ask (DR-019)
    if (!onApprovalNeeded) return 'deny';
    const requestId = crypto.randomUUID();
    return onApprovalNeeded(requestId, toolName, args, nsName);
  };
}

/**
 * Run the shared validator and map the decision to execute / skip / abort.
 * Returns a human-readable denial message when not allowed.
 */
export async function authorizeToolExecution(
  registry: ToolRegistry,
  policy: ToolPolicyConfig | undefined,
  toolName: string,
  args: unknown,
  onApprovalNeeded?: OnToolApprovalNeeded,
): Promise<{ decision: ApprovalDecision; message?: string }> {
  const validator = createToolValidator(registry, policy, onApprovalNeeded);
  const decision = await validator(toolName, args);
  if (decision === 'allow') {
    return { decision };
  }
  if (decision === 'abort') {
    return { decision, message: 'Tool execution aborted by policy' };
  }
  const resolved = registry.resolve(toolName);
  const nsName = resolved?.namespacedName || toolName;
  const tier = classifyToolPolicy(nsName, policy);
  if (tier === 'disabled') {
    return {
      decision: 'deny',
      message: `Tool "${nsName}" is disabled by tool_policy.disabled_tools`,
    };
  }
  return {
    decision: 'deny',
    message: `Tool execution denied by policy (${nsName})`,
  };
}
