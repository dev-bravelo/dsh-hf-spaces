/**
 * Stop rules, cost and the /space command syntax, without Harness imports (docs/design.md,
 * section 4). The rules run in this plugin, so they apply only while the Harness is open.
 */

export const STOP_DEFAULTS = Object.freeze({ idleMinutes: 30, sessionMinutes: 60, warnMinutes: 5, extendMinutes: 60 });

/** At the time limit, an answer still streaming may finish for this long before the pause. */
export const BUSY_GRACE_MS = 10 * 60000;
/** A request this recent counts as work in progress: tools run between requests. */
export const ACTIVE_WINDOW_MS = 2 * 60000;

/**
 * Checks `stop` settings. Minutes may be fractional; 0 turns the idle rule or the time limit off.
 * @returns {{ stop: object } | { problem: string }}
 */
export function normalizeStop(raw = {}) {
  const stop = { ...STOP_DEFAULTS };
  for (const key of Object.keys(STOP_DEFAULTS)) {
    if (raw?.[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) return { problem: `stop.${key} must be a number of minutes, 0 or more` };
    stop[key] = raw[key];
  }
  if (stop.extendMinutes <= 0) return { problem: 'stop.extendMinutes must be more than 0' };
  if (stop.sessionMinutes > 0 && stop.warnMinutes >= stop.sessionMinutes) return { problem: 'stop.warnMinutes must be less than stop.sessionMinutes' };
  return { stop };
}

/** Time limit of a start this plugin made, counted from the start; undefined when there is none. */
export const deadlineOf = (startedAt, stop) => (stop.sessionMinutes > 0 ? startedAt + stop.sessionMinutes * 60000 : undefined);

/** A new time limit `minutes` after the later of the current one and now. */
export const extendedDeadline = (deadline, minutes, now) => Math.max(deadline, now) + minutes * 60000;

/**
 * Why a tracked Space must stop now, or undefined.
 * tracked = { readyAt?, lastActivity?, startedAt?, deadline? }: a deadline exists only for a start
 * this plugin made; a Space started elsewhere gets the idle rule only.
 * busy = an answer is streaming or a request was recent: at the time limit it may finish.
 * streaming = an answer is streaming now: the idle rule waits for it (idleness counts from the
 * end of the last answer, so a recent request alone never blocks it).
 * @returns {{ kind: 'limit' | 'idle', minutes: number } | undefined}
 */
export function stopReason({ now, tracked, stop, busy = false, streaming = false }) {
  if (tracked?.readyAt === undefined) return undefined; // a time can be 0 on a test clock
  if (tracked.deadline !== undefined && now >= tracked.deadline && !(busy && now < tracked.deadline + BUSY_GRACE_MS)) {
    return { kind: 'limit', minutes: (tracked.deadline - tracked.startedAt) / 60000 };
  }
  if (stop.idleMinutes > 0 && !streaming && now - Math.max(tracked.readyAt, tracked.lastActivity ?? 0) >= stop.idleMinutes * 60000) {
    return { kind: 'idle', minutes: stop.idleMinutes };
  }
  return undefined;
}

/** True once, `warnMinutes` before the time limit of a Space that serves. */
export function warnDue({ now, tracked, stop }) {
  if (tracked?.readyAt === undefined || tracked.deadline === undefined || tracked.warned || !(stop.warnMinutes > 0)) return false;
  return now >= tracked.deadline - stop.warnMinutes * 60000 && now < tracked.deadline;
}

/** Minutes Hugging Face bills for `ms`: every started minute (6 min 39 s billed as 7, 2026-10-30). */
export const billedMinutes = ms => Math.ceil(Math.max(0, ms) / 60000);

/** Estimated cost of `ms` on hardware billed at `usdPerMinute`, counted as Hugging Face bills it. */
export const costUsd = (ms, usdPerMinute) => billedMinutes(ms) * usdPerMinute;

/**
 * `/space` input: `status`, `on`, `off`, `+N` (extend by N minutes; `+` alone uses the default),
 * each optionally followed by a route. An empty input is `status`.
 * @returns {{ action: 'status' | 'on' | 'off' | 'extend', minutes?: number, route?: string } | undefined}
 */
export function parseCommand(input) {
  const words = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  const [first = 'status', route] = words;
  if (words.length > 2) return undefined;
  const word = first.toLowerCase();
  const target = route ? { route } : {};
  if (word === 'status') return { action: 'status', ...target };
  if (word === 'on' || word === 'off') return { action: word, ...target };
  const extend = /^\+([1-9]\d{0,2})?$/.exec(word); // +0 would extend by nothing
  if (extend) return { action: 'extend', ...(extend[1] ? { minutes: Number(extend[1]) } : {}), ...target };
  return undefined;
}

/** "15:42" in the given locale. */
export const clockTime = (ms, locale) => new Date(ms).toLocaleTimeString(locale === 'pt-BR' ? 'pt-BR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

/** "US$ 2.63" or "US$ 2,63". */
export const formatUsd = (value, locale) => `US$ ${locale === 'pt-BR' ? value.toFixed(2).replace('.', ',') : value.toFixed(2)}`;
