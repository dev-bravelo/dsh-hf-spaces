/**
 * The /space command and the stop rules on the Harness (docs/design.md, section 4). The command
 * never sends anything to a model. The rules run here, so they apply only while the Harness is
 * open; when it is closed, only the Space's own sleep time stops it.
 */
import { ACTIVE_WINDOW_MS, clockTime, costUsd, extendedDeadline, formatUsd, parseCommand, stopReason, warnDue } from './rules.mjs';
import { formatDuration } from './gate.mjs';

const TICK_MS = 60000;
const PRICES_TTL_MS = 6 * 3600000;
const VIEW_CHECK_MS = 60000;

/**
 * @param options.entries - the same Map route -> entry the chat gate uses
 * @param options.chat - attachChat() result: startFromCommand, stop
 */
export function attachControl({ ctx, entries, chat, hf, texts, locale, pollMs, log, now = Date.now }) {
  let disposed = false;

  // ---- Cost: Hugging Face bills every started minute, at the public price of the hardware.
  let prices; // the request itself is cached, so parallel callers share one read
  let pricesAt = 0;
  const pricePerMinute = async (hardware) => {
    if (!hardware) return undefined;
    if (!prices || now() - pricesAt > PRICES_TTL_MS) {
      pricesAt = now();
      prices = hf.listHardwarePrices().catch((error) => {
        log?.warn?.(`hardware prices not read: ${error?.message ?? error}`);
        pricesAt = 0; // read again next time
        return undefined;
      });
    }
    return (await prices)?.get(hardware);
  };
  const hardwareOf = entry => entry.supervisor.state().hardware ?? entry.facts.hardware;
  const startCost = async (entry) => {
    const since = entry.tracked?.startedAt ?? entry.tracked?.readyAt;
    const rate = await pricePerMinute(hardwareOf(entry));
    return since === undefined || rate === undefined ? undefined : formatUsd(costUsd(now() - since, rate), locale);
  };

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
        await stopFor(entry, reason.kind === 'limit' ? `time limit of ${reason.minutes} min` : `${reason.minutes} min without use`);
      }
    } finally {
      ticking = false;
    }
  };
  const interval = setInterval(() => { void tick(); }, Math.min(TICK_MS, pollMs));
  interval.unref?.();

  // ---- /space
  const routes = () => [...entries.keys()];
  /** The Space a command is about: the route given, or the only one configured. Never a guess. */
  const target = (route) => {
    if (entries.size === 0) return { error: texts.noSpaces };
    if (route) return entries.get(route) ?? { error: texts.unknownRoute(route, routes()) };
    if (entries.size === 1) return [...entries.values()][0];
    return { error: texts.whichSpace(routes()) };
  };

  const statusText = async (entry) => {
    // Read the Space again: a Space started or paused elsewhere makes the last known state stale.
    await entry.supervisor.check().catch(() => {});
    const state = entry.supervisor.state();
    const tracked = entry.tracked;
    const since = tracked?.startedAt ?? tracked?.readyAt;
    const stop = entry.facts.stop;
    const serving = state.phase === 'ready' || tracked?.readyAt !== undefined;
    return texts.status({
      label: entry.label,
      route: entry.route,
      phase: texts.phase[state.phase] ?? state.phase,
      stage: state.phase === 'starting' ? state.stage : undefined,
      hardware: serving ? hardwareOf(entry) : undefined,
      on: since === undefined ? undefined : formatDuration((now() - since) / 1000),
      cost: await startCost(entry),
      stopsAt: tracked?.deadline !== undefined ? clockTime(tracked.deadline, locale) : undefined,
      idle: serving && stop.idleMinutes > 0 ? `${stop.idleMinutes} min` : undefined,
      warning: tracked?.warned,
      extend: stop.extendMinutes,
      reason: state.phase === 'failed' ? state.reason : entry.lastStop?.reason,
      refused: entry.refusedEfforts?.length ? texts.refusedEfforts(entry.refusedEfforts.join(', ')) : undefined,
    });
  };

  const run = async ({ agent, rawInput }) => {
    const command = parseCommand(rawInput);
    if (!command) return { kind: 'error', text: texts.usage };
    if (command.action === 'status' && !command.route && entries.size > 1) {
      return { kind: 'success', text: (await Promise.all([...entries.values()].map(statusText))).join('\n') };
    }
    const entry = target(command.route);
    if (entry.error) return { kind: 'error', text: entry.error };
    if (command.action === 'status') return { kind: 'success', text: await statusText(entry) };
    if (command.action === 'on') {
      const text = await chat.startFromCommand(entry, agent?.session?.id);
      if (text) return { kind: 'success', text };
      const rate = await pricePerMinute(hardwareOf(entry));
      return { kind: 'success', text: texts.onStarting(entry.label, rate === undefined ? undefined : formatUsd(rate * 60, locale), texts.where(entry.label)) };
    }
    if (command.action === 'off') {
      // Never trust the last known state here: the stop reads the Space and pauses only when needed.
      const { state, cost } = await stopFor(entry, '/space off');
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
        description: 'Hugging Face Spaces without calling the model: status, on, off, +N extends the time limit',
        input: { hint: 'status | on | off | +60 [route]' },
        handler: run,
      });
    }, 'space command');
  });

  /**
   * What the interface shows for each Space (Client half, slice 6). Built from what this Harness
   * already knows: no Hugging Face request, so the interface can poll it often.
   */
  const views = async () => Promise.all([...entries.values()].map(async (entry) => {
    // A Space started or paused elsewhere: read it again in the background, at most once a minute.
    if (!entry.starting && now() - (entry.checkedAt ?? 0) > VIEW_CHECK_MS) {
      entry.checkedAt = now();
      void entry.supervisor.check().catch(() => {});
    }
    const state = entry.supervisor.state();
    const tracked = entry.tracked;
    const since = tracked?.startedAt ?? tracked?.readyAt;
    return {
      route: entry.route,
      label: entry.label,
      phase: entry.starting ? 'starting' : state.phase,
      phaseText: texts.phase[entry.starting ? 'starting' : state.phase] ?? state.phase,
      progress: entry.starting ? chat.progressOf(entry) : undefined,
      hardware: state.phase === 'ready' ? hardwareOf(entry) : undefined,
      on: since === undefined ? undefined : formatDuration((now() - since) / 1000),
      cost: since === undefined ? undefined : await startCost(entry),
      stopsAt: tracked?.deadline !== undefined ? clockTime(tracked.deadline, locale) : undefined,
      warning: Boolean(tracked?.warned),
      extend: entry.facts.stop.extendMinutes,
      failure: state.phase === 'failed' ? (entry.lastFailure ?? state.reason) : undefined,
      refused: entry.refusedEfforts?.length ? texts.refusedEfforts(entry.refusedEfforts.join(', ')) : undefined,
    };
  }));

  return {
    run,
    tick,
    views,
    dispose() {
      disposed = true;
      clearInterval(interval);
    },
  };
}
