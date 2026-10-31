/**
 * One Space's lifecycle, without Harness imports: off -> starting -> ready -> stopping -> off, plus
 * failed. It starts and pauses the Space through the Hugging Face client and decides "ready" only
 * when the Space's own server lists every configured model. See docs/design.md, section 4.
 *
 * Safety rules:
 * - A start that this supervisor began and that fails, or is not ready in time, pauses the Space,
 *   so it never bills without serving. A Space started elsewhere is left as it is.
 * - A pause counts only once Hugging Face confirms it: a stopped stage and no hardware attached.
 * - Every start reads the Space again: a "ready" seen earlier may be stale (paused on the web, or
 *   asleep after its sleep time).
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Hugging Face stages grouped by what the supervisor does with them (docs/contracts.md, section 1). */
export function stageKind(stage) {
  if (stage === 'PAUSED' || stage === 'STOPPED' || stage === 'SLEEPING') return 'stopped';
  // The app may already answer in these; the model list decides.
  if (stage === 'RUNNING' || stage === 'RUNNING_BUILDING' || stage === 'RUNNING_APP_STARTING') return 'running';
  if (stage === 'BUILDING' || stage === 'APP_STARTING') return 'starting';
  if (stage === 'BUILD_ERROR' || stage === 'RUNTIME_ERROR' || stage === 'CONFIG_ERROR' || stage === 'NO_APP_FILE') return 'error';
  return 'unknown';
}

/** Paused for good: a stopped stage with no hardware attached. */
export const isPaused = runtime => stageKind(runtime?.stage) === 'stopped' && !runtime?.current;

/** One line for logs: "off", "starting (APP_STARTING)", "ready on a100-large", "failed: ...". */
export function describeState(state) {
  if (state.phase === 'ready') return `ready${state.hardware ? ` on ${state.hardware}` : ''}`;
  if (state.phase === 'starting' || state.phase === 'unknown') return `${state.phase}${state.stage ? ` (${state.stage})` : ''}`;
  if (state.phase === 'failed') return `failed: ${state.reason}${state.warning ? `; ${state.warning}` : ''}${state.note ? `; ${state.note}` : ''}`;
  return `${state.phase}${state.reason ? ` (${state.reason})` : ''}`;
}

export const POLL_MS = 5000;
/** How long Hugging Face may take to confirm a pause before the plugin reports it as unconfirmed. */
export const PAUSE_CONFIRM_MS = 3 * 60000;
const BILLING_WARNING = 'the pause was not confirmed; the GPU may still bill. Pause the Space on Hugging Face';
const LEFT_RUNNING = 'the Space was already running or starting when this start began, so it was left as it is';

/**
 * Renders a start variable declared as data (docs/design.md, section 4). A string that is exactly
 * a placeholder becomes its value; placeholders inside longer strings are replaced as text.
 * - `{{uuid}}`: a new random id for each start
 * - `{{now}}`: Unix seconds at the start
 * - `{{readyDeadline}}`: Unix seconds when the plugin gives up (now + start.readyTimeoutMinutes)
 * Objects are written as compact JSON, the form a Space reads from one variable.
 */
export function renderStartVariable(value, { now, readyTimeoutMinutes, uuid = () => crypto.randomUUID() }) {
  const seconds = Math.floor(now / 1000);
  const exact = { '{{now}}': seconds, '{{readyDeadline}}': seconds + readyTimeoutMinutes * 60 };
  const render = (v) => {
    if (typeof v === 'string') {
      if (Object.hasOwn(exact, v)) return exact[v];
      return v.replace(/\{\{(uuid|now|readyDeadline)\}\}/g, name => (name === '{{uuid}}' ? uuid() : String(exact[name])));
    }
    if (Array.isArray(v)) return v.map(render);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x)]));
    return v;
  };
  const rendered = render(value);
  return typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
}

/** Waits without keeping the process alive; rejects when `signal` aborts. */
const abortableSleep = (ms, signal) => delay(ms, undefined, { signal, ref: false });

/** What an error stage means, and where to look next. */
const stageProblem = runtime => `the Space reported ${runtime.stage}${runtime.error ? `: ${runtime.error}` : ''}; see its run log on Hugging Face`;

/**
 * @param options.space - { id, baseURL, modelIds: string[], hardware?, readyTimeoutMinutes }
 * @param options.client - Hugging Face client (hf.mjs)
 * @param options.onChange - called with every new state
 */
export function createSupervisor({ space, client, onChange, now = Date.now, sleep = abortableSleep, pollMs = POLL_MS, pauseConfirmMs = PAUSE_CONFIRM_MS }) {
  let current = { phase: 'unknown', since: now() };
  let operation; // { kind: 'start' | 'stop', promise, controller }

  const set = (phase, extra = {}) => {
    current = { phase, since: now(), ...extra };
    onChange?.(current);
    return current;
  };

  /**
   * Ready when the server lists every configured model. A server that lists other models is
   * misconfigured, and a refused credential will not fix itself: both end the wait at once.
   */
  async function served(signal) {
    let ids;
    try {
      ids = await client.listServedModels(space.baseURL);
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        return { ready: false, fatal: `the Space refused the inference credential (HTTP ${error.status}); set one that can read the Space` };
      }
      return { ready: false }; // not up yet
    }
    signal?.throwIfAborted();
    const missing = space.modelIds.filter(id => !ids.includes(id));
    if (missing.length === 0) return { ready: true };
    if (ids.length === 0) return { ready: false };
    return { ready: false, fatal: `the Space serves ${ids.join(', ')}, not ${missing.join(', ')}; fix the model ids in the configuration or the manifest` };
  }

  /** Pauses (unless already paused) and waits for Hugging Face to confirm it. */
  async function pauseConfirmed(signal) {
    let runtime = await client.getRuntime(space.id);
    signal?.throwIfAborted();
    if (isPaused(runtime)) return { paused: true, runtime, already: true };
    runtime = await client.pause(space.id);
    const deadline = now() + pauseConfirmMs;
    while (!isPaused(runtime)) {
      if (now() >= deadline) return { paused: false, runtime };
      await sleep(pollMs, signal);
      try { runtime = await client.getRuntime(space.id); } catch { /* keep waiting */ }
    }
    return { paused: true, runtime };
  }

  /**
   * A failed start. Only a Space this start began is paused for safety; the result says whether
   * billing stopped. A stop that cancels this start wins: nothing is set after an abort.
   */
  async function failStart(reason, signal, startedHere) {
    if (!startedHere) return set('failed', { reason, note: LEFT_RUNNING });
    set('stopping', { reason });
    let paused = false;
    try {
      paused = (await pauseConfirmed(signal)).paused;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    signal.throwIfAborted();
    return set('failed', { reason, paused, ...(paused ? {} : { warning: BILLING_WARNING }) });
  }

  async function runStart(signal) {
    const startedAt = now();
    let runtime = await client.getRuntime(space.id);
    signal.throwIfAborted();
    let kind = stageKind(runtime.stage);
    let startedHere = false;
    if (kind === 'running') {
      const check = await served(signal);
      if (check.ready) return set('ready', { stage: runtime.stage, hardware: runtime.current });
      if (check.fatal) return failStart(check.fatal, signal, false);
    }
    if (kind === 'stopped' || kind === 'error') {
      // The Space's own start handshake, if it declares one (for example a fresh start deadline).
      for (const [key, value] of Object.entries(space.startVariables ?? {})) {
        await client.setVariable(space.id, key, renderStartVariable(value, { now: now(), readyTimeoutMinutes: space.readyTimeoutMinutes }));
        signal.throwIfAborted();
      }
      runtime = space.hardware && runtime.requested !== space.hardware
        ? await client.requestHardware(space.id, space.hardware) // restarts on the new hardware
        : await client.restart(space.id);
      startedHere = true;
      signal.throwIfAborted();
    }
    // `requested`: the hardware billed while it starts, for the cost of a start that fails.
    const requested = runtime.requested ?? space.hardware;
    set('starting', { stage: runtime.stage, startedAt, ...(requested ? { requested } : {}) });
    const deadline = startedAt + space.readyTimeoutMinutes * 60000;
    for (;;) {
      await sleep(pollMs, signal);
      try {
        runtime = await client.getRuntime(space.id);
      } catch {
        runtime = undefined; // a passing network error: keep waiting until the deadline
      }
      signal.throwIfAborted();
      kind = stageKind(runtime?.stage);
      if (kind === 'error') return failStart(stageProblem(runtime), signal, startedHere);
      if (kind === 'running') {
        const check = await served(signal);
        if (check.ready) return set('ready', { stage: runtime.stage, hardware: runtime.current, startedAt });
        if (check.fatal) return failStart(check.fatal, signal, startedHere);
      }
      if (runtime && current.phase === 'starting' && runtime.stage !== current.stage) {
        set('starting', { stage: runtime.stage, startedAt, ...(requested ? { requested } : {}) });
      }
      if (now() >= deadline) {
        return failStart(`not ready after ${space.readyTimeoutMinutes} min; see the Space run log on Hugging Face, or raise start.readyTimeoutMinutes if it is only slow`, signal, startedHere);
      }
    }
  }

  async function runStop(reason, signal) {
    set('stopping', { reason });
    const { paused, already } = await pauseConfirmed(signal);
    return paused ? set('off', { reason, ...(already ? { already: true } : {}) }) : set('failed', { reason, paused: false, warning: BILLING_WARNING });
  }

  function begin(kind, run) {
    const controller = new AbortController();
    // The operation is recorded before any of it runs: a start() or stop() called from onChange
    // during its first synchronous step must already see it.
    const promise = Promise.resolve().then(() => run(controller.signal)).catch(error => {
      if (controller.signal.aborted) return { ...current }; // replaced by a stop, or disposed
      const message = error?.message ?? String(error);
      return kind === 'start'
        ? set('failed', { reason: `start failed: ${message}; try again, or check the Space on Hugging Face` })
        // The pause request itself failed, so nothing says billing stopped.
        : set('failed', { reason: `stop failed: ${message}`, paused: false, warning: BILLING_WARNING });
    }).finally(() => {
      if (operation?.promise === promise) operation = undefined;
    });
    operation = { kind, promise, controller };
    return promise;
  }

  return {
    /** The current state; never a live object. */
    state: () => ({ ...current }),

    /** Reads the Space once and sets the state from it, without starting or stopping anything. */
    async check() {
      if (operation) return { ...current };
      const runtime = await client.getRuntime(space.id);
      const kind = stageKind(runtime.stage);
      const check = kind === 'running' ? await served() : undefined;
      if (operation) return { ...current }; // a start or stop began meanwhile
      if (kind === 'stopped') return set(isPaused(runtime) ? 'off' : 'stopping', { stage: runtime.stage });
      if (kind === 'error') return set('failed', { stage: runtime.stage, reason: stageProblem(runtime) });
      if (check?.ready) return set('ready', { stage: runtime.stage, hardware: runtime.current });
      if (check?.fatal) return set('failed', { stage: runtime.stage, reason: check.fatal, note: LEFT_RUNNING });
      return set(kind === 'unknown' ? 'unknown' : 'starting', { stage: runtime.stage });
    },

    /** Starts the Space, or joins the start already running. Resolves with the final state. */
    start() {
      if (operation?.kind === 'start') return operation.promise;
      if (operation?.kind === 'stop') return Promise.resolve({ ...current, note: 'the Space is stopping; start it again once it is off' });
      return begin('start', runStart);
    },

    /**
     * Stops the Space, cancelling a start in progress. An already paused Space is not paused
     * again. Resolves with the final state.
     */
    stop(reason = 'stopped') {
      if (operation?.kind === 'stop') return operation.promise;
      operation?.controller.abort(new Error('replaced by a stop'));
      return begin('stop', signal => runStop(reason, signal));
    },

    /** Stops watching. The Space itself is left as it is. */
    dispose() {
      operation?.controller.abort(new Error('disposed'));
      operation = undefined;
    },
  };
}
