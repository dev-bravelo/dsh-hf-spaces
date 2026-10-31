/**
 * Start progress, without Harness imports (docs/design.md, section 7): phase, percent and time
 * left, from the Space stage, the optional event lines of its run log and the warm-up.
 * Generalized from the private prototype, whose estimate was checked in real starts on
 * 2026-10-19 to 10-30.
 */

/** Typical seconds of each phase, measured on an A100 with a 27B model, 2026-10-19 to 10-30. */
export const START_PHASES = Object.freeze({ allocate: 25, copy: 92, load: 55, warmup: 45 });

/**
 * The event of one run-log line, or undefined. A line carries `<prefix> {json}`, anywhere in the
 * line (timestamps may come first). Lines with another prefix, or cut JSON, are ignored.
 */
export function parseEventLine(line, prefix) {
  if (!prefix) return undefined;
  const at = String(line).indexOf(prefix);
  if (at < 0) return undefined;
  const brace = line.indexOf('{', at + prefix.length);
  if (brace < 0) return undefined;
  try {
    const event = JSON.parse(line.slice(brace));
    return event && typeof event === 'object' && typeof event.stage === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}

const isCopy = stage => /^(copy_|model_verified|projector_)/.test(stage ?? '');

/**
 * @param state.event - latest event from the run log, or undefined
 * @param state.loading - a "loading" event was seen, or the server answers (it loads before it lists)
 * @param state.warming - the server lists the models and the warm-up requests run
 * @param timing - seconds since the start, since the latest event, since loading, since warm-up began
 * @returns {{ phase: 'allocate' | 'copy' | 'load' | 'warmup', percent: number, secondsLeft: number }}
 */
export function estimate(state, { elapsed = 0, sinceEvent = 0, sinceLoad = 0, sinceWarm = 0 } = {}, phases = START_PHASES) {
  let phase;
  let done;
  let left;
  if (state.warming) {
    phase = 'warmup';
    done = 85 + 15 * Math.min(sinceWarm / phases.warmup, 0.95);
    left = Math.max(phases.warmup - sinceWarm, 5);
  } else if (state.loading) {
    phase = 'load';
    done = 60 + 25 * Math.min(sinceLoad / phases.load, 0.95);
    left = Math.max(phases.load - sinceLoad, 5) + phases.warmup;
  } else if (isCopy(state.event?.stage)) {
    phase = 'copy';
    const e = state.event;
    let fraction;
    let copyLeft;
    if (e.stage === 'copy_progress' && e.total_bytes > 0) {
      // Measured bytes and rate, moved forward by the time since that line.
      const rate = e.seconds > 0 ? e.bytes / e.seconds : 0;
      fraction = Math.min((e.bytes + rate * sinceEvent) / e.total_bytes, 0.99);
      copyLeft = rate > 0 ? (e.total_bytes * (1 - fraction)) / rate : phases.copy * (1 - fraction);
    } else {
      fraction = e.stage === 'copy_from_bucket' ? 0 : 0.98;
      copyLeft = phases.copy * (1 - fraction);
    }
    done = 10 + 50 * fraction;
    left = copyLeft + phases.load + phases.warmup;
  } else {
    phase = 'allocate';
    done = 10 * Math.min(elapsed / phases.allocate, 0.95);
    left = Math.max(phases.allocate - elapsed, 10) + phases.copy + phases.load + phases.warmup;
  }
  return { phase, percent: Math.min(99, Math.round(done)), secondsLeft: Math.round(left) };
}

/** "45 s", "1 min 50 s", "3 min": under a minute in steps of 5 s, longer in steps of 10 s. */
export function roughDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${Math.round(s / 5) * 5} s`;
  let min = Math.floor(s / 60);
  let rest = Math.round((s % 60) / 10) * 10;
  if (rest === 60) { min += 1; rest = 0; }
  return rest ? `${min} min ${rest} s` : `${min} min`;
}
