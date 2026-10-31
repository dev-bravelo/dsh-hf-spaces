/**
 * The chat gate on the Harness (docs/design.md, section 8). Before each conversation request to a
 * Space's route:
 * - when the Space serves, the request goes on;
 * - when it is off, the plugin starts it, answers that turn with one fixed line written as the
 *   plugin, shows a progress job in the session header, and resumes the session when the Space
 *   is ready, quoting the user's waiting message.
 * Other requests (such as session titles) never start a Space.
 *
 * Proven by the private prototype in a real start on 2026-10-30: the resumed turn answered the
 * user, and holding a wait on the progress job kept dsh-tool-jobs from sending a "job finished"
 * notice that would open a model turn.
 */
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { NOTICE_SOURCE, READY_TTL_MS, USER_KILL_REASON, fixedReply, formatDuration, inCooldown, pendingUserText, planRequest } from './gate.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { estimate, parseEventLine, roughDuration } from './progress.mjs';
import { deadlineOf } from './rules.mjs';
import { stageKind } from './supervisor.mjs';

const PROGRESS_MS = 3000;
const JOB_KIND = 'hf-space';
/** The whole warm-up and effort check may take this long; the sessions resume after it anyway. */
const WARMUP_MAX_MS = 3 * 60000;
const REFUSALS = [400, 422, 500];

/**
 * @param options.entries - Map route -> entry, kept by index.mjs; an entry is
 *   { route, label, facts, supervisor, readyUntil, waiters: Map<agent, { text, sessionId }>,
 *     progress: Map<sessionId, job>, sleepSeconds?, lastFailureAt?, starting?, startedAt?,
 *     tracked?: { readyAt?, lastActivity?, startedAt?, deadline?, warned? }, inFlight? }
 *   The tracked part exists while this Harness knows the Space serves; it feeds the stop rules.
 * @param options.token - async (kind) => token or undefined
 * @param options.credentialNames - { inference, control } names, for messages
 */
export function attachChat({ ctx, entries, hf, texts, token, credentialNames, log, pollMs = 5000, now = Date.now }) {
  let disposed = false;

  /** True when the Space's server lists every configured model right now. */
  const servesNow = async (entry) => {
    try {
      const ids = await hf.listServedModels(entry.facts.baseURL);
      return entry.facts.modelIds.every(id => ids.includes(id));
    } catch {
      return false;
    }
  };

  /** A plugin message to each agent's next turn (it opens one when the agent is idle). */
  const deliver = (agents, textFor) => {
    for (const agent of agents) {
      try {
        const message = createUserMessage({ content: [{ type: 'text', text: textFor(agent) }], source: { kind: NOTICE_SOURCE } });
        // Checked against the installed session format before it is queued (a plugin's old format
        // was once refused by a newer codec; AGENTS.md, section 7).
        sessionFormatCatalog.encodeCurrentEvent({ type: 'agent/inbox/spliced', seq: agent.session.seq, time: now(),
          data: { target: 'next-turn', start: agent.inbox?.nextTurn?.length ?? 0, removedCount: 0, inserted: [message] } });
        agent.followup(message);
      } catch (error) {
        log?.warn?.(`could not notify session ${agent?.session?.id}: ${error?.message ?? error}`);
      }
    }
  };

  // ---- Progress: one background job per waiting session, in that session's header. The estimate
  // follows the Space stage, the event lines of its run log and the warm-up (progress.mjs).
  const live = entry => (entry.live ??= {});
  const progressLine = (entry) => {
    const l = entry.live ?? {};
    const at = now();
    const since = from => (from === undefined ? 0 : (at - from) / 1000);
    const loadFrom = l.loadAt ?? l.runningAt; // the server loads the model before it lists it
    const progress = estimate(
      { event: l.event, loading: loadFrom !== undefined, warming: l.warmAt !== undefined },
      { elapsed: since(entry.startedAt), sinceEvent: since(l.eventAt), sinceLoad: since(loadFrom), sinceWarm: since(l.warmAt) },
    );
    return texts.progressLine(texts.phases[progress.phase], progress.percent, roughDuration(progress.secondsLeft));
  };

  /** Follows the Space run log while it starts, for the copy and load events (design, section 7). */
  const watchLog = async (entry) => {
    const prefix = entry.facts.eventPrefix;
    if (!prefix) return;
    const controller = new AbortController();
    entry.logWatch = controller;
    while (!controller.signal.aborted && entry.starting) {
      // A paused Space answers the log request with nothing at all: open it only once it starts.
      const state = entry.supervisor.state();
      if (state.phase !== 'starting' || stageKind(state.stage) === 'stopped') {
        await delay(Math.min(pollMs, 1000), undefined, { signal: controller.signal, ref: false }).catch(() => {});
        continue;
      }
      try {
        await hf.followRunLog(entry.facts.id, {
          signal: controller.signal,
          onLine: (line, timestamp) => {
            const event = parseEventLine(line, prefix);
            if (!event) return;
            const l = live(entry);
            // A reconnection replays recent lines: date each event by its log time, not by now.
            const loggedAt = Date.parse(timestamp);
            l.event = event;
            l.eventAt = Number.isFinite(loggedAt) ? Math.min(loggedAt, now()) : now();
            if (event.stage === 'loading') l.loadAt ??= now();
            refreshProgress(entry);
          },
        });
      } catch { /* not up yet (no headers while paused), or a passing network error */ }
      await delay(pollMs, undefined, { signal: controller.signal, ref: false }).catch(() => {});
    }
  };

  /**
   * Warm-up and effort check, once the server lists the models (design, section 6, step 6): one
   * minimal request per configured effort level, which also warms the model. A level the server
   * refuses is reported, with the fix. After the first check in this Harness, one request is
   * enough for the warm-up.
   */
  const warmUp = async (entry) => {
    live(entry).warmAt = now();
    refreshProgress(entry);
    // Checked again when the models or the Space revision change.
    const key = JSON.stringify([entry.sha, entry.facts.models]);
    const checked = entry.effortsChecked === key;
    const refused = [];
    const cap = new AbortController(); // the whole warm-up, not each request
    const timer = setTimeout(() => cap.abort(new Error('warm-up took too long')), WARMUP_MAX_MS);
    const probe = async (model, value) => {
      try {
        return await hf.probeChat(entry.facts.baseURL, model, value, cap.signal);
      } catch {
        return { ok: false, status: 0 };
      }
    };
    try {
      for (const model of entry.facts.models) {
        const levels = model.reasoning ? Object.entries(model.reasoning) : [[undefined, undefined]];
        for (const [level, value] of checked ? levels.slice(0, 1) : levels) {
          if (cap.signal.aborted || entry.stoppedByUser) return; // out of time, or the user stopped it
          let result = await probe(model.id, value);
          // Seen 2026-09-21: a llama.cpp template answers HTTP 500 to a value it does not know.
          // 400 and 422 are assumed to mean the same. A 500 can also be a passing overload, so a
          // level counts as refused only when the server refuses it twice.
          if (level !== undefined && REFUSALS.includes(result.status)) result = await probe(model.id, value);
          if (level !== undefined && REFUSALS.includes(result.status)) refused.push(`${model.id}: ${level}`);
        }
        if (checked) break;
      }
      if (!checked) {
        entry.effortsChecked = key;
        entry.refusedEfforts = refused;
        if (refused.length) log?.warn?.(`${entry.facts.id}: ${texts.refusedEfforts(refused.join(', '))}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const refreshProgress = (entry) => {
    const line = progressLine(entry);
    for (const job of entry.progress.values()) {
      try { job.handle?.updateProgress(line); } catch { /* settled meanwhile */ }
    }
  };
  const trackProgress = (entry, sessionId) => {
    const jobs = ctx.get('jobs');
    if (!jobs || !sessionId || !entry.starting || entry.progress.has(sessionId)) return;
    const job = {};
    const done = new Promise(resolve => { job.finish = resolve; });
    try {
      job.id = jobs.start({
        kind: JOB_KIND,
        label: texts.progressLabel(entry.label),
        owner: sessionId,
        run: (handle) => {
          job.handle = handle;
          handle.updateProgress(progressLine(entry));
          return {
            done,
            cancel: (reason) => {
              const current = entries.get(entry.route) ?? entry; // the entry may have been replaced
              if (reason === USER_KILL_REASON) {
                current.stoppedByUser = current.supervisor.stop('stopped from the start task');
                return;
              }
              // The session closed: only its progress and its wake end; the start goes on for the others.
              current.progress.delete(sessionId);
              for (const [agent, waiter] of current.waiters) if (waiter.sessionId === sessionId) current.waiters.delete(agent);
              job.finish({ status: 'killed', detail: texts.sessionClosed });
            },
          };
        },
      });
    } catch (error) {
      log?.warn?.(`start progress unavailable in session ${sessionId}: ${error?.message ?? error}`);
      return;
    }
    entry.progress.set(sessionId, job);
    // Holding this wait makes the settlement count as collected, so no "job finished" notice is sent.
    jobs.wait(job.id, 6 * 3600000, sessionId).catch(() => {});
  };
  const stopTimer = (entry) => {
    clearInterval(entry.progressTimer);
    entry.progressTimer = undefined;
  };
  const finishProgress = (entry, status, detail) => {
    for (const job of entry.progress.values()) job.finish({ status, detail });
    entry.progress.clear();
    stopTimer(entry);
  };

  /** The Space serves: trust it for a while, and track it for the idle rule if not yet tracked. */
  const markServing = (entry) => {
    entry.readyUntil = now() + READY_TTL_MS;
    entry.tracked ??= { lastActivity: now() };
    entry.tracked.readyAt ??= now();
    // Started elsewhere after the startup check: bring the supervisor's state up to date.
    if (entry.supervisor.state().phase !== 'ready') void entry.supervisor.check().catch(() => {});
  };

  /** What happens once a start settles: resume, report a failure, or end a user stop. */
  async function settle(entry, state) {
    entry.logWatch?.abort();
    // The user chose to stop: not a failure, so no cooldown and no notice into the sessions.
    const endUserStop = async () => {
      const stopped = await entry.stoppedByUser;
      entry.stoppedByUser = undefined;
      entry.tracked = undefined;
      finishProgress(entry, 'killed', stopped.phase === 'off' ? texts.stoppedDetail : texts.stopUnconfirmed(stopped.reason ?? stopped.phase));
      entry.waiters.clear();
    };
    try {
      if (entry.stoppedByUser) {
        await endUserStop();
      } else if (state.phase === 'ready') {
        // The warm-up runs while `starting` is still set, so new requests wait with the others
        // instead of queueing behind it on a single-slot server.
        try {
          await warmUp(entry);
        } catch (error) {
          // The warm-up only helps; whatever happens in it, the sessions still resume.
          log?.warn?.(`${entry.facts.id}: warm-up failed: ${error?.message ?? error}`);
        }
        if (entry.stoppedByUser) {
          await endUserStop();
        } else {
          const elapsed = (now() - entry.startedAt) / 1000;
          markServing(entry);
          finishProgress(entry, 'completed', texts.readyDetail(entry.label, formatDuration(elapsed)));
          deliver([...entry.waiters.keys()], agent => texts.ready(entry.label, Math.round(elapsed), entry.waiters.get(agent)?.text));
          entry.waiters.clear();
        }
      } else {
        // No chat turn is opened for a failure (design, section 8): the reason shows in the start
        // task, and the next message to this Space gets the cooldown notice.
        entry.lastFailureAt = now();
        entry.tracked = undefined;
        entry.lastFailure = texts.failed(entry.label, state.reason ?? state.phase, state.paused);
        finishProgress(entry, 'failed', entry.lastFailure);
        entry.waiters.clear();
      }
    } finally {
      entry.starting = undefined;
      entry.live = undefined;
    }
    return state;
  }

  /**
   * Starts (or joins the start of) the Space once for every waiting session, then settles.
   * A start this plugin begins on a stopped Space gets the time limit; joining one gets idle rules only.
   */
  const startFor = (entry, startedHere = false) => {
    if (entry.starting) return entry.starting;
    entry.startedAt ??= now();
    // No lastActivity here: a start is not a request, so it gives no grace at the time limit
    // (idleness counts from readyAt until the first request).
    if (startedHere) entry.tracked = { startedAt: entry.startedAt, deadline: deadlineOf(entry.startedAt, entry.facts.stop) };
    entry.stoppedByUser = undefined;
    stopTimer(entry);
    entry.progressTimer = setInterval(() => refreshProgress(entry), PROGRESS_MS);
    entry.progressTimer.unref?.();
    entry.live = {};
    entry.starting = entry.supervisor.start().then(state => settle(entry, state));
    void watchLog(entry);
    return entry.starting;
  };

  /** A session that waits for the start: woken when ready, with the text its user typed. */
  const addWaiter = (entry, agent, request) => {
    if (!agent) return;
    entry.waiters.set(agent, { text: pendingUserText(request.messages), sessionId: request.sessionId });
    trackProgress(entry, request.sessionId);
  };
  const join = (entry, agent, request) => {
    addWaiter(entry, agent, request);
    return texts.stillStarting(entry.label, Math.round((now() - entry.startedAt) / 1000), progressLine(entry));
  };

  /** undefined to send the request to the Space, or the text of the plugin's own reply. */
  const decide = async (entry, request, agent) => {
    const plan = planRequest({ now: now(), readyUntil: entry.readyUntil, phase: entry.starting ? 'starting' : undefined });
    if (plan === 'proceed') return undefined;
    if (plan === 'starting') return join(entry, agent, request);
    if (await servesNow(entry)) {
      markServing(entry);
      return undefined;
    }
    if (entry.starting) return join(entry, agent, request); // started by another request meanwhile
    // A failed probe is not proof the Space is off (a network error, a 5xx): read its stage.
    let kind;
    try {
      kind = stageKind((await hf.getRuntime(entry.facts.id)).stage);
    } catch {
      return texts.unknownState(entry.label);
    }
    if (entry.starting) return join(entry, agent, request);
    const off = kind === 'stopped' || kind === 'error';
    if (off && !entry.facts.automatic) return texts.manualOnly(entry.label, entry.route);
    if (off && inCooldown({ now: now(), lastFailureAt: entry.lastFailureAt })) return `${entry.lastFailure} ${texts.cooldown(entry.label)}`;
    const missing = await preflight(entry, off);
    if (missing) return missing;
    entry.startedAt = now();
    void startFor(entry, off); // a running or starting Space is joined, never restarted
    addWaiter(entry, agent, request);
    return off
      ? `${texts.starting(entry.label, texts.where(entry.label))} ${texts.rules(entry.facts.stop, entry.sleepSeconds)}`
      : texts.waking(entry.label, texts.where(entry.label));
  };

  /** Without either credential a start would fail after the GPU began to bill: refuse it first. */
  const preflight = async (entry, off) => {
    if (!(await token('inference'))) return texts.noCredential(entry.label, credentialNames.inference, texts.readAccess);
    if (off && !(await token('control'))) return texts.noCredential(entry.label, credentialNames.control, texts.writeAccess);
    return undefined;
  };

  async function* gated(entry, request, next) {
    const agent = ctx.get('agents')?.get?.(request.sessionId);
    const text = await decide(entry, request, agent);
    if (text === undefined) {
      entry.inFlight = (entry.inFlight ?? 0) + 1;
      try {
        yield* await next();
      } finally {
        entry.inFlight -= 1;
        if (entry.tracked) entry.tracked.lastActivity = now(); // idleness counts from the end of the last answer
      }
      return;
    }
    log?.info?.(`request to ${entry.label} answered by the plugin (session ${request.sessionId}): ${text.slice(0, 80)}`);
    yield* fixedReply(text);
  }

  ctx.on('llm/stream', (request, next) => {
    const entry = disposed ? undefined : entries.get(request?.provider);
    if (!entry || !isAgentLoopRequest(request)) return next();
    return gated(entry, request, next);
  }, { prepend: true });

  // A failed request may mean the Space stopped: check again before the next one.
  ctx.on('agent/request-error', (_payload, next) => {
    for (const entry of entries.values()) entry.readyUntil = 0;
    return next();
  });

  return {
    /** The progress line of a start in progress, for the interface. */
    progressOf: entry => progressLine(entry),
    /**
     * /space on: starts the Space without a model request; the session gets the progress job but
     * is not resumed (a resume would open a model turn). Returns a text, or undefined when a start
     * began (the caller writes that text, with the hourly price).
     */
    async startFromCommand(entry, sessionId) {
      if (entry.starting) {
        trackProgress(entry, sessionId);
        return texts.stillStarting(entry.label, Math.round((now() - entry.startedAt) / 1000), progressLine(entry));
      }
      if (await servesNow(entry)) {
        markServing(entry);
        return texts.alreadyServing(entry.label);
      }
      let kind;
      try {
        kind = stageKind((await hf.getRuntime(entry.facts.id)).stage);
      } catch {
        return texts.unknownState(entry.label);
      }
      const off = kind === 'stopped' || kind === 'error';
      const missing = await preflight(entry, off);
      if (missing) return missing;
      entry.lastFailureAt = undefined; // a manual start ignores the cooldown
      entry.startedAt = now();
      void startFor(entry, off);
      trackProgress(entry, sessionId);
      return undefined;
    },
    /** /space off and the stop rules: cancels a start in progress, pauses, ends the progress jobs. */
    async stop(entry, reason) {
      const stopping = entry.supervisor.stop(reason);
      if (entry.starting) entry.stoppedByUser = stopping; // not a failure: no cooldown, no notice
      const state = await stopping;
      entry.readyUntil = 0;
      if (state.phase === 'off') entry.tracked = undefined;
      return state;
    },
    /** Called on every supervisor state change: progress lines follow the stage at once. */
    onState(entry) {
      const state = entry.supervisor.state();
      if (entry.starting && state.phase === 'starting' && stageKind(state.stage) === 'running') live(entry).runningAt ??= now();
      if (entry.progress.size) refreshProgress(entry);
    },
    /**
     * A configuration change replaced an entry. A start in progress goes on: the new entry takes
     * over its waiting sessions and progress jobs and watches the start (its supervisor joins it).
     */
    transfer(previous, next) {
      stopTimer(previous);
      if (!previous.starting) return;
      next.waiters = previous.waiters;
      next.progress = previous.progress;
      next.startedAt = previous.startedAt;
      previous.waiters = new Map();
      previous.progress = new Map();
      void startFor(next);
    },
    /** Ends the progress jobs of an entry that goes away for good. */
    release(entry) {
      finishProgress(entry, 'failed', texts.replaced);
      entry.waiters.clear();
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) this.release(entry);
    },
  };
}
