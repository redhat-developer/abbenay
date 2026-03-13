/**
 * Session summarizer — periodic LLM-generated session summaries.
 *
 * Fires a background LLM call every SUMMARY_INTERVAL user messages to produce
 * a short summary of the conversation. The summary is persisted on the session
 * and available through the index for fast listing.
 *
 * Core layer (no transport dependencies).
 */

import type { CoreState } from './state.js';
import type { Session, SessionStore } from './session-store.js';

const SUMMARY_INTERVAL = 10;

const SUMMARY_SYSTEM_PROMPT =
  'You are a concise summarizer. Given the conversation below, produce a 2-3 sentence summary ' +
  'capturing the key topics, decisions, and outcomes. Do not include greetings or filler. ' +
  'Reply with only the summary text.';

/**
 * Generate an LLM summary of a session's conversation history.
 *
 * Uses the session's own model by default, or an explicit override.
 * Tools are disabled — this is a plain text-in / text-out call.
 */
export async function generateSessionSummary(
  state: CoreState,
  session: Session,
  model?: string,
): Promise<string> {
  const targetModel = model || session.model;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
  ];

  if (session.summary) {
    messages.push({
      role: 'user',
      content: `Previous summary (may be outdated):\n${session.summary}\n\nHere is the full conversation so far:`,
    });
  }

  const conversationText = session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  messages.push({ role: 'user', content: conversationText || '(empty conversation)' });

  let summary = '';
  for await (const chunk of state.chat(targetModel, messages, undefined, { toolMode: 'none' })) {
    if (chunk.type === 'text' && chunk.text) {
      summary += chunk.text;
    }
  }

  return summary.trim();
}

/**
 * Check whether a session needs a summary refresh and generate one if so.
 *
 * Intended to be called fire-and-forget (`void maybeSummarize(...)`) after
 * a chat turn completes. Errors are caught and logged, never propagated.
 */
export async function maybeSummarize(
  state: CoreState,
  sessionId: string,
  store: SessionStore,
  model?: string,
): Promise<void> {
  try {
    const session = await store.get(sessionId, true);
    const userMessageCount = session.messages.filter((m) => m.role === 'user').length;

    if (userMessageCount < SUMMARY_INTERVAL) return;
    if (userMessageCount % SUMMARY_INTERVAL !== 0) return;
    if (session.summaryMessageCount === userMessageCount) return;

    const summary = await generateSessionSummary(state, session, model);
    if (summary) {
      await store.updateSummary(sessionId, summary, userMessageCount);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Summarizer] Failed to summarize session ${sessionId}: ${msg}`);
  }
}
