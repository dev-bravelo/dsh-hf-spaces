/**
 * The /space command, the stop rules and what the interface shows (docs/design.md, sections 4
 * and 9). The command never sends anything to a model. The rules run here, so they apply only
 * while the Harness is open; when it is closed, only the Space's own sleep time stops it.
 */
import { ACTIVE_WINDOW_MS, clockTime, costUsd, extendedDeadline, formatUsd, parseCommand, stopReason, warnDue } from './rules.mjs';
import { formatDuration } from './gate.mjs';

const TICK_MS = 60000;
const VIEW_CHECK_MS = 60000;
const HISTORY = 5;

/**
 * @param options.entries - the same Map route -> entry the chat gate uses
 * @param options.chat - attachChat() result: startFromCommand, stop, progressOf
 * @param options.account - attachAccount() result: prices, usage, credentials, starts
 */
export function attachControl({ ctx, entries, chat, account, texts, locale, pollMs, log, now = Date.now }) {
  let disposed = false;

  // ---- Cost: Hugging Face bills every started minute, at the public price of the hardware.
  const hardwareOf = entry => entry.supervisor.state().hardware ?? entry.facts.hardware;
  const costSince = (since, rate) => (since === undefined || rate === undefined ? undefined : formatUsd(costUsd(now() - since, rate), locale));
  const startCost = async (entry) => costSince(entry.tracked?.startedAt ?? entry.tracked?.readyAt, await account.pricePerMinute(hardwareOf(entry)));
  /** The same, without waiting for the price list: the interface polls, and the cost comes once it is read. */
  const startCostNow = entry => costSince(entry.tracked?.startedAt ?? entry.tracked?.readyAt, account.pricePerMinuteNow(hardwareOf(entry)));

  // ---- Stop rules: every minute (or every poll, when shorter).
  const stopFor = async (entry, why) => {
    const cost = await startCost(entry);
    const state = await chat.stop(entry, why);
    entry.lastStop = { reason: why, at: now(), cost, paused: state.phase === 'off' };
    log?.info?.(`${entry.facts.id}: stopped (${why})${cost ? `, estimated cost ${cost}` : ''}${state.phase === 'off' ? '' : `; ${state.warning ?? state.reason}`}`);
    return { state, cost };
  };
  let ticking = false;
  const tick = async () => {
    if (disposed || ticking) return;
    ticking = true;
    try {
      for (const entry of entries.values()) {
        const tracked = entry.tracked;
        if (!tracked || entry.starting) continue;
        const stop = entry.facts.stop;
        if (warnDue({ now: now(), tracked, stop })) {
          tracked.warned = true;
          log?.info?.(`${entry.facts.id}: time limit at ${clockTime(tracked.deadline, locale)}; /space +${stop.extendMinutes} extends it`);
        }
        const streaming = (entry.inFlight ?? 0) > 0;
        const busy = streaming || now() - (tracked.lastActivity ?? 0) < ACTIVE_WINDOW_MS;
        const reason = stopReason({ now: now(), tracked, stop, busy, streaming });
        if (!reason) continue;
        await stopFor(entry, reason.kind === 'limit' ? texts.limitReason(reason.minutes) : texts.idleReason(reason.minutes));
      }
    } finally {
      ticking = false;
    }
  };
  const interval = setInterval(() => { void tick(); }, Math.min(TICK_MS, pollMs));
  interval.unref?.();

  // ---- What Hugging Face billed for a Space today and this month (read in the background).
  const usageText = (entry) => {
    const usage = account.usage(entry.facts.id);
    if (usage.value) return texts.usageLine(usage.value, v => formatUsd(v, locale));
    return usage.error ? texts.usageUnavailable(usage.error) : undefined;
  };

  // ---- /space
  const routes = () => [...entries.keys()];
  /** The Space a command is about: the route given, or the only one configured. Never a guess. */
  const target = (route) => {
    if (entries.size === 0) return { error: texts.noSpaces };
    if (route) return entries.get(route) ?? { error: texts.unknownRoute(route, routes()) };
    if (entries.size === 1) return [...entries.values()][0];
    return { error: texts.whichSpace(routes()) };
  };

  /**
   * Why the last start failed, until the next start: a failed start is paused, and the next read
   * of the Space then says "off", which alone would hide the reason.
   */
  const failureOf = (entry) => {
    const state = entry.supervisor.state();
    if (entry.starting || state.phase === 'ready') return undefined; // started again, here or elsewhere
    return entry.lastFailure ?? (state.phase === 'failed' ? state.reason : undefined);
  };

  const statusText = async (entry) => {
    // Read the Space again: a Space started or paused elsewhere makes the last known state stale.
    await entry.supervisor.check().catch(() => {});
    const state = entry.supervisor.state();
    const tracked = entry.tracked;
    const since = tracked?.startedAt ?? tracked?.readyAt;
    const stop = entry.facts.stop;
    const serving = state.phase === 'ready' || tracked?.readyAt !== undefined;
    const phase = entry.starting ? 'starting' : state.phase; // the start may not have reached the supervisor yet
    return texts.status({
      label: entry.label,
      route: entry.route,
      phase: texts.phase[phase] ?? phase,
      stage: state.phase === 'starting' ? state.stage : undefined,
      progress: entry.starting ? chat.progressOf(entry).text : undefined,
      hardware: serving ? hardwareOf(entry) : undefined,
      on: since === undefined ? undefined : formatDuration((now() - since) / 1000),
      cost: await startCost(entry),
      stopsAt: tracked?.deadline !== undefined ? clockTime(tracked.deadline, locale) : undefined,
      idle: serving && stop.idleMinutes > 0 ? `${stop.idleMinutes} min` : undefined,
      warning: tracked?.warned,
      extend: stop.extendMinutes,
      reason: state.phase === 'failed' ? state.reason : entry.lastStop?.reason,
      failure: failureOf(entry),
      refused: entry.refusedEfforts?.length ? texts.refusedEfforts(entry.refusedEfforts.join(', ')) : undefined,
      usage: usageText(entry),
    });
  };

  const run = async ({ rawInput }) => {
    const command = parseCommand(rawInput);
    if (!command) return { kind: 'error', text: texts.usage };
    if (command.action === 'status' && !command.route && entries.size > 1) {
      return { kind: 'success', text: (await Promise.all([...entries.values()].map(statusText))).join('\n') };
    }
    const entry = target(command.route);
    if (entry.error) return { kind: 'error', text: entry.error };
    if (command.action === 'status') return { kind: 'success', text: await statusText(entry) };
    if (command.action === 'on') {
      const text = await chat.startFromCommand(entry);
      if (text) return { kind: 'success', text };
      const rate = await account.pricePerMinute(hardwareOf(entry));
      return { kind: 'success', text: texts.onStarting(entry.label, rate === undefined ? undefined : formatUsd(rate * 60, locale), texts.where(entry.label)) };
    }
    if (command.action === 'off') {
      // Never trust the last known state here: the stop reads the Space and pauses only when needed.
      const { state, cost } = await stopFor(entry, texts.offReason);
      if (state.phase === 'off' && state.already) return { kind: 'success', text: texts.alreadyOff(entry.label) };
      return state.phase === 'off'
        ? { kind: 'success', text: texts.offDone(entry.label, cost) }
        : { kind: 'error', text: texts.offFailed(entry.label, state.warning ?? state.reason) };
    }
    // extend
    const tracked = entry.tracked;
    if (tracked?.readyAt === undefined && !entry.starting) return { kind: 'error', text: texts.notRunning(entry.label) };
    if (tracked?.deadline === undefined) return { kind: 'success', text: texts.noLimit(entry.label) };
    const minutes = command.minutes ?? entry.facts.stop.extendMinutes;
    tracked.deadline = extendedDeadline(tracked.deadline, minutes, now());
    tracked.warned = false;
    const stop = entry.facts.stop;
    return { kind: 'success', text: texts.extended(entry.label, minutes, clockTime(tracked.deadline, locale), stop.idleMinutes > 0 ? `${stop.idleMinutes} min` : undefined) };
  };

  // The command service may start after this plugin: wait for it (lesson 1 of the prototype).
  ctx.inject(['commands'], (sub) => {
    sub.effect(function* () {
      yield sub.commands.register({
        name: 'space',
        description: texts.commandDescription,
        input: { hint: 'status | on | off | +60 [route]' },
        handler: run,
      });
    }, 'space command');
  });

  /** One start record as the interface shows it. */
  const startView = start => ({
    at: start.startedAt,
    day: new Date(start.startedAt).toLocaleDateString(locale === 'pt-BR' ? 'pt-BR' : 'en-GB', { day: '2-digit', month: '2-digit' }),
    clock: clockTime(start.startedAt, locale),
    duration: start.endedAt === undefined ? undefined : formatDuration((start.endedAt - start.startedAt) / 1000),
    open: start.endedAt === undefined && start.end === undefined,
    // A start only seen serving began earlier than recorded: its cost is a minimum.
    ...(start.seen ? { seen: true } : {}),
    ...(start.cost === undefined ? {} : { cost: `${start.seen ? '≥ ' : ''}${formatUsd(start.cost, locale)}` }),
    ...(start.end ? { end: start.end === 'unknown' ? texts.endUnknown : start.end } : {}),
  });

  /**
   * What the interface shows for each Space. Built from what this Harness already knows: no
   * Hugging Face request waits here, so the interface can poll it often.
   */
  const views = async () => Promise.all([...entries.values()].map((entry) => {
    // A Space started or paused elsewhere: read it again in the background, at most once a minute.
    if (!entry.starting && now() - (entry.checkedAt ?? 0) > VIEW_CHECK_MS) {
      entry.checkedAt = now();
      void entry.supervisor.check().catch(() => {});
    }
    const state = entry.supervisor.state();
    const tracked = entry.tracked;
    const since = tracked?.startedAt ?? tracked?.readyAt;
    const usage = account.usage(entry.facts.id);
    const phase = entry.starting ? 'starting' : state.phase;
    const progress = entry.starting ? chat.progressOf(entry) : undefined;
    return {
      route: entry.route,
      label: entry.label,
      space: entry.facts.id,
      models: entry.facts.modelIds,
      phase,
      phaseText: texts.phase[phase] ?? phase,
      progress: progress?.text,
      stage: progress?.phase,
      percent: progress?.percent,
      left: progress?.left,
      hardware: state.phase === 'ready' ? hardwareOf(entry) : undefined,
      on: since === undefined ? undefined : formatDuration((now() - since) / 1000),
      cost: startCostNow(entry),
      stopsAt: tracked?.deadline !== undefined ? clockTime(tracked.deadline, locale) : undefined,
      idle: entry.facts.stop.idleMinutes,
      warning: Boolean(tracked?.warned),
      extend: entry.facts.stop.extendMinutes,
      failure: failureOf(entry),
      failureAt: failureOf(entry) ? entry.lastFailureAt : undefined, // a new failure is a new notice
      refused: entry.refusedEfforts?.length ? texts.refusedEfforts(entry.refusedEfforts.join(', ')) : undefined,
      usage: usage.value ? { today: formatUsd(usage.value.today.usd, locale), todayMinutes: usage.value.today.minutes, month: formatUsd(usage.value.month.usd, locale), monthMinutes: usage.value.month.minutes } : undefined,
      usageError: usage.error, // with a value: the value is older than the last read
      starts: account.starts(entry.facts.id, HISTORY).map(startView),
      logTail: entry.logTail?.length ? [...entry.logTail] : undefined,
    };
  }));

  /** The account part of the interface: the state of each credential. */
  const accountView = async () => ({ credentials: await account.credentials() });

  return {
    run,
    tick,
    views,
    accountView,
    dispose() {
      disposed = true;
      clearInterval(interval);
    },
  };
}
