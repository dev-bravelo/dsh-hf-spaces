import assert from 'node:assert/strict';
import { test } from 'node:test';
import { START_PHASES, estimate, parseEventLine, roughDuration } from '../src/progress.mjs';

test('event lines: the configured prefix, then JSON with a stage; anything else is ignored', () => {
  assert.deepEqual(parseEventLine('SPACE_EVENT {"stage": "loading"}', 'SPACE_EVENT'), { stage: 'loading' });
  assert.equal(parseEventLine('2026-10-30T19:13 SPACE_EVENT {"stage": "copy_from_bucket", "bytes": 1}', 'SPACE_EVENT').stage, 'copy_from_bucket');
  assert.equal(parseEventLine('OTHER_EVENT {"stage": "loading"}', 'SPACE_EVENT'), undefined);
  assert.equal(parseEventLine('SPACE_EVENT {"stage": "load', 'SPACE_EVENT'), undefined, 'a cut line');
  assert.equal(parseEventLine('SPACE_EVENT {"no": "stage"}', 'SPACE_EVENT'), undefined);
  assert.equal(parseEventLine('SPACE_EVENT {"stage": "x"}', undefined), undefined, 'no prefix configured: no events');
});

test('estimate: each phase in its band, the copy from measured bytes and rate', () => {
  const allocate = estimate({}, { elapsed: 10 });
  assert.equal(allocate.phase, 'allocate');
  assert.ok(allocate.percent < 10);
  // 22.5 GB at 220 MB/s, 20 s in, read 5 s ago (real numbers from 2026-10-30).
  const copy = estimate({ event: { stage: 'copy_progress', bytes: 4420796416, total_bytes: 22533850592, seconds: 20 } }, { sinceEvent: 5 });
  assert.equal(copy.phase, 'copy');
  assert.ok(copy.percent > 10 && copy.percent < 60, `copy ${copy.percent}`);
  assert.ok(copy.secondsLeft > START_PHASES.load + START_PHASES.warmup);
  const load = estimate({ loading: true }, { sinceLoad: 20 });
  assert.equal(load.phase, 'load');
  assert.ok(load.percent >= 60 && load.percent < 85);
  const warm = estimate({ loading: true, warming: true }, { sinceWarm: 10 });
  assert.equal(warm.phase, 'warmup');
  assert.ok(warm.percent >= 85 && warm.percent <= 99);
  assert.ok(estimate({ warming: true }, { sinceWarm: 1e6 }).percent <= 99, 'never 100 before it is ready');
});

test('rough durations: steps of 5 s under a minute, 10 s above', () => {
  assert.equal(roughDuration(42), '40 s');
  assert.equal(roughDuration(118), '2 min');
  assert.equal(roughDuration(125), '2 min 10 s');
});
