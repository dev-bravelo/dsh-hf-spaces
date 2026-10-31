import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUSY_GRACE_MS, STOP_DEFAULTS, billedMinutes, clockTime, costUsd, deadlineOf, extendedDeadline, formatUsd, normalizeStop, parseCommand, stopReason, warnDue } from '../src/rules.mjs';

const min = 60000;
const stop = { ...STOP_DEFAULTS };

test('stop settings: defaults, fractional minutes, zero turns a rule off, coherent limits', () => {
  assert.deepEqual(normalizeStop(undefined).stop, STOP_DEFAULTS);
  assert.equal(normalizeStop({ idleMinutes: 0.05 }).stop.idleMinutes, 0.05);
  assert.equal(normalizeStop({ sessionMinutes: 0 }).stop.sessionMinutes, 0);
  assert.match(normalizeStop({ idleMinutes: -1 }).problem, /stop\.idleMinutes/);
  assert.match(normalizeStop({ extendMinutes: 0 }).problem, /extendMinutes must be more than 0/);
  assert.match(normalizeStop({ sessionMinutes: 5, warnMinutes: 5 }).problem, /warnMinutes must be less/);
});

test('time limit: counted from the start; extended from the later of the limit and now', () => {
  assert.equal(deadlineOf(0, stop), 60 * min);
  assert.equal(deadlineOf(0, { ...stop, sessionMinutes: 0 }), undefined);
  assert.equal(extendedDeadline(60 * min, 60, 56 * min), 120 * min);
  assert.equal(extendedDeadline(60 * min, 60, 65 * min), 125 * min);
});

test('stop reason: limit for starts made here, idle for all, an answer in progress may finish', () => {
  const started = { startedAt: 0, readyAt: 4 * min, lastActivity: 50 * min, deadline: 60 * min };
  assert.equal(stopReason({ now: 59 * min, tracked: started, stop }), undefined);
  assert.deepEqual(stopReason({ now: 60 * min, tracked: started, stop }), { kind: 'limit', minutes: 60 });
  assert.equal(stopReason({ now: 61 * min, tracked: started, stop, busy: true }), undefined, 'the answer may finish');
  assert.equal(stopReason({ now: 60 * min + BUSY_GRACE_MS, tracked: started, stop, busy: true }).kind, 'limit', 'but not forever');
  const outside = { readyAt: 0, lastActivity: 10 * min }; // started elsewhere: no limit
  assert.equal(stopReason({ now: 39 * min, tracked: outside, stop }), undefined);
  assert.deepEqual(stopReason({ now: 40 * min, tracked: outside, stop }), { kind: 'idle', minutes: 30 });
  assert.equal(stopReason({ now: 40 * min, tracked: outside, stop: { ...stop, idleMinutes: 0 } }), undefined);
  assert.equal(stopReason({ now: 40 * min, tracked: outside, stop, streaming: true }), undefined, 'an answer still streaming is use');
  assert.equal(stopReason({ now: 40 * min, tracked: outside, stop, busy: true }).kind, 'idle', 'a recent request alone does not block the idle rule');
  assert.equal(stopReason({ now: 40 * min, tracked: { lastActivity: 0 }, stop }), undefined, 'never stops a Space not seen serving');
});

test('warning: once, warnMinutes before the limit, only while serving', () => {
  const tracked = { startedAt: 0, readyAt: 4 * min, deadline: 60 * min };
  assert.equal(warnDue({ now: 54 * min, tracked, stop }), false);
  assert.equal(warnDue({ now: 55 * min, tracked, stop }), true);
  assert.equal(warnDue({ now: 55 * min, tracked: { ...tracked, warned: true }, stop }), false);
  assert.equal(warnDue({ now: 55 * min, tracked: { ...tracked, readyAt: undefined }, stop }), false);
});

test('cost: every started minute, at the per-minute price', () => {
  assert.equal(billedMinutes((6 * 60 + 39) * 1000), 7);
  assert.equal(billedMinutes(0), 0);
  assert.equal(formatUsd(costUsd((6 * 60 + 39) * 1000, 0.041667), 'en'), 'US$ 0.29');
  assert.equal(formatUsd(2.625, 'pt-BR'), 'US$ 2,63');
  assert.match(clockTime(Date.UTC(2026, 9, 31, 15, 42), 'pt-BR'), /^\d{2}:\d{2}$/);
});

test('/space syntax: status by default, on, off, +N, an optional route; anything else is refused', () => {
  assert.deepEqual(parseCommand(''), { action: 'status' });
  assert.deepEqual(parseCommand('on my-llm'), { action: 'on', route: 'my-llm' });
  assert.deepEqual(parseCommand('OFF'), { action: 'off' });
  assert.deepEqual(parseCommand('+30'), { action: 'extend', minutes: 30 });
  assert.deepEqual(parseCommand('+ my-llm'), { action: 'extend', route: 'my-llm' });
  assert.deepEqual(parseCommand('+'), { action: 'extend' });
  assert.equal(parseCommand('start everything now'), undefined);
  assert.equal(parseCommand('+1000'), undefined);
  assert.equal(parseCommand('+0'), undefined, 'extending by nothing is refused');
});
