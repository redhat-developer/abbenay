/**
 * AI SDK telemetry registration for the Abbenay daemon (DR-042).
 *
 * Opt-in via ABBENAY_AI_TELEMETRY=1. When enabled, registers @ai-sdk/otel
 * with privacy-safe defaults (inputs/outputs not recorded by streamChat).
 * No Datadog/Langfuse hard dependency.
 */

import { registerTelemetry } from 'ai';
import { debug } from '../core/debug.js';

let registered = false;

/**
 * Register pluggable AI SDK telemetry when opted in. Safe to call multiple times.
 */
export async function initAiSdkTelemetry(): Promise<void> {
  if (registered) return;

  const enabled = process.env.ABBENAY_AI_TELEMETRY === '1'
    || process.env.ABBENAY_AI_TELEMETRY === 'true';
  if (!enabled) {
    debug('[Telemetry] Skipped (set ABBENAY_AI_TELEMETRY=1 or true to enable)');
    return;
  }

  try {
    const { OpenTelemetry } = await import('@ai-sdk/otel');
    registerTelemetry(new OpenTelemetry());
    registered = true;
    debug('[Telemetry] Registered @ai-sdk/otel (ABBENAY_AI_TELEMETRY)');
  } catch (err) {
    debug(
      `[Telemetry] @ai-sdk/otel failed to load: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
