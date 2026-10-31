/**
 * Pure helpers for the chat gate (docs/design.md, section 8), without Harness imports: what to do
 * with a model request to a Space, the user text to quote on resume, and the plugin's own reply.
 */

/** Source kind of the messages this plugin puts in a session. */
export const NOTICE_SOURCE = 'dsh-hf-spaces';

/** After a failed start, automatic starts wait this long; a manual start ignores it. */
export const FAILURE_COOLDOWN_MS = 10 * 60000;

/** A Space seen serving is trusted for this long before the next request checks again. */
export const READY_TTL_MS = 2 * 60000;

/** Reason the jobs UI sends when the user presses a job's stop control (dsh-api-job-controller, 0.2.1-rc.3). */
export const USER_KILL_REASON = 'cancelled by the user';

/**
 * What to do with a conversation request to a Space.
 * @returns {'proceed' | 'check' | 'starting'}
 */
export function planRequest({ now, readyUntil = 0, phase }) {
  if (now < readyUntil) return 'proceed';
  if (phase === 'starting') return 'starting';
  return 'check';
}

/** Whether an automatic start may run now, or waits for the cooldown after a failure. */
export const inCooldown = ({ now, lastFailureAt }) => lastFailureAt !== undefined && now - lastFailureAt < FAILURE_COOLDOWN_MS;

/**
 * The last text the user typed in a request's messages, to quote when the session resumes:
 * without the quote, a model answered the plugin's own notice instead of the user (2026-10-30).
 */
export function pendingUserText(messages, maxChars = 1500) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
    if (!text) return undefined;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return undefined;
}

/** A complete assistant reply in the adapter stream protocol: visible text, normal end of turn. */
export async function* fixedReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** "45 s", "2 min 05 s". */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
