import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LEDGER_FILE, attachAccount, createLedger, defaultStateDir, resolveStateDir, spaceUsage } from '../src/account.mjs';
import { textsFor } from '../src/messages.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hf-spaces-')), LEDGER_FILE);
const USAGE = {
  usage: {
    Spaces: [
      { label: 'your-user/your-llm-space', quantity: 30, totalCostMicroUSD: 1250000 },
      { label: 'your-user/your-llm-space', quantity: 12, totalCostMicroUSD: 500000 },
      { label: 'your-user/other', quantity: 99, totalCostMicroUSD: 9000000 },
    ],
  },
};

test('records folder: under the Harness home, which DSH_HOME moves; a relative stateDir is under it too', () => {
  const home = path.resolve('user-home');
  const data = path.resolve('data', 'dsh');
  assert.equal(defaultStateDir({}, home), path.join(home, '.dsh', 'state', 'dsh-hf-spaces'));
  assert.equal(defaultStateDir({ DSH_HOME: data }, home), path.join(data, 'state', 'dsh-hf-spaces'));
  assert.equal(defaultStateDir({ DSH_HOME: '~/other' }, home), path.join(home, 'other', 'state', 'dsh-hf-spaces'));
  assert.equal(resolveStateDir(undefined, {}, home), defaultStateDir({}, home));
  assert.equal(resolveStateDir('records', {}, home), path.join(home, '.dsh', 'records'), 'never the process folder');
  assert.equal(resolveStateDir(data, {}, home), data);
  assert.equal(resolveStateDir('~/kept', {}, home), path.join(home, 'kept'));
});

test('usage of one Space: minutes and US$ summed over its items only', () => {
  assert.deepEqual(spaceUsage(USAGE, 'your-user/your-llm-space'), { minutes: 42, usd: 1.75 });
  assert.deepEqual(spaceUsage(USAGE, 'your-user/none'), { minutes: 0, usd: 0 });
  assert.equal(spaceUsage({}, 'x'), undefined);
});

test('ledger: saved to its file, read back, newest first; an open start left by a closed Harness is marked unknown', () => {
  const file = tempFile();
  const ledger = createLedger({ file });
  ledger.open({ space: 's/a', route: 'a', startedAt: 1, endedAt: 2, end: 'done' });
  ledger.open({ space: 's/b', route: 'b', startedAt: 3 });
  ledger.open({ space: 's/a', route: 'a', startedAt: 5 });
  assert.deepEqual(ledger.starts('s/a').map(s => s.startedAt), [5, 1]);
  const again = createLedger({ file });
  assert.deepEqual(again.starts('s/a').map(s => [s.startedAt, s.end]), [[5, 'unknown'], [1, 'done']]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  // A broken file is not fatal: the plugin starts with no records.
  fs.writeFileSync(file, '{');
  assert.deepEqual(createLedger({ file }).starts('s/a'), []);
});

test('ledger: keeps the last 50 starts', () => {
  const ledger = createLedger({ file: tempFile() });
  for (let i = 0; i < 60; i += 1) ledger.open({ space: 's/a', route: 'a', startedAt: i });
  assert.equal(ledger.starts('s/a', 100).length, 50);
  assert.equal(ledger.starts('s/a', 1)[0].startedAt, 59);
});

function account({ usage = USAGE, whoami = async kind => ({ user: 'your-user', role: kind === 'control' ? 'write' : 'read' }), tokens = { inference: 't1', control: 't2', billing: 't1' }, now = () => 1_000_000 } = {}) {
  const calls = [];
  const hf = {
    getBillingUsage: async (from, to) => { calls.push(['usage', from, to]); if (usage instanceof Error) throw usage; return usage; },
    whoami: async (kind) => { calls.push(['whoami', kind]); return whoami(kind); },
    listHardwarePrices: async () => { calls.push(['prices']); return new Map([['a100-large', 0.041667]]); },
  };
  const ledger = createLedger({ file: tempFile() });
  const a = attachAccount({ hf, ledger, token: async kind => tokens[kind], credentialNames: { inference: 'HF_TOKEN', control: 'SPACE_CONTROL', billing: 'HF_TOKEN' }, now });
  return { a, calls, ledger };
}

test('usage: read in the background, cached, then served from the cache', async () => {
  const { a, calls } = account();
  assert.equal(a.usage('your-user/your-llm-space').value, undefined, 'the first call never waits');
  await tick();
  await tick();
  assert.deepEqual(a.usage('your-user/your-llm-space').value, { today: { minutes: 42, usd: 1.75 }, month: { minutes: 42, usd: 1.75 } });
  assert.equal(calls.filter(c => c[0] === 'usage').length, 2, 'one read for today, one for the month; none again within 10 min');
  const failing = account({ usage: new Error('HTTP 403 (the billing credential cannot read the account billing)') });
  failing.a.usage('x');
  await tick();
  await tick();
  assert.match(failing.a.usage('x').error, /HTTP 403/);
});

test('credentials: missing, accepted with the account and role, checked once per token', async () => {
  const { a, calls } = account({ tokens: { inference: 't1', control: undefined, billing: 't1' } });
  const first = await a.credentials();
  assert.deepEqual(first.find(c => c.kind === 'control'), { kind: 'control', name: 'SPACE_CONTROL', present: false });
  await tick();
  await tick();
  const second = await a.credentials();
  assert.deepEqual(second.find(c => c.kind === 'inference'), { kind: 'inference', name: 'HF_TOKEN', present: true, ok: true, user: 'your-user', role: 'read' });
  await a.credentials();
  assert.equal(calls.filter(c => c[0] === 'whoami').length, 1, 'one check for the token inference and billing share, not one per poll');
  assert.deepEqual(second.find(c => c.kind === 'billing'), { kind: 'billing', name: 'HF_TOKEN', present: true, ok: true, user: 'your-user', role: 'read' });
  const refused = account({ whoami: async () => { throw new Error('the inference credential was not accepted: HTTP 401'); } });
  await refused.a.credentials();
  await tick();
  await tick();
  assert.match((await refused.a.credentials())[0].error, /HTTP 401/);
});

test('prices: the interface reads them without waiting; they come once the list is read', async () => {
  const { a, calls } = account();
  assert.equal(a.pricePerMinuteNow('a100-large'), undefined, 'not read yet: no wait, no cost shown');
  await tick();
  assert.equal(a.pricePerMinuteNow('a100-large'), 0.041667);
  assert.equal(await a.pricePerMinute('a100-large'), 0.041667);
  assert.equal(calls.filter(c => c[0] === 'prices').length, 1, 'one read for both');
});

test('a start that fails before ready is costed on the hardware it asked for', async () => {
  let clock = 1_000_000;
  const { a, ledger } = account({ now: () => clock });
  const entry = { route: 'my-llm', facts: { id: 'your-user/your-llm-space' } }; // no hardware configured
  a.track(entry, { phase: 'starting', startedAt: clock, requested: 'a100-large' }, textsFor('en'));
  clock += 6 * 60000;
  a.track(entry, { phase: 'failed', reason: 'the Space reported RUNTIME_ERROR' }, textsFor('en'));
  await tick();
  await tick();
  const [start] = ledger.starts('your-user/your-llm-space');
  assert.equal(start.hardware, 'a100-large');
  assert.equal(start.cost, 6 * 0.041667);
});

test('starts follow the supervisor: opened when starting or first seen serving, closed with the reason and cost', async () => {
  let clock = 1_000_000;
  const { a, ledger } = account({ now: () => clock });
  const texts = textsFor('en');
  const entry = { route: 'my-llm', facts: { id: 'your-user/your-llm-space', hardware: 'a100-large' } };
  a.track(entry, { phase: 'starting', startedAt: clock }, texts);
  clock += 4 * 60000;
  a.track(entry, { phase: 'ready', hardware: 'a100-large' }, texts);
  a.track(entry, { phase: 'ready', hardware: 'a100-large' }, texts); // the periodic check repeats it
  clock += 30 * 60000 + 1;
  a.track(entry, { phase: 'off', reason: '30 min without use' }, texts);
  await tick();
  await tick();
  const [start] = ledger.starts('your-user/your-llm-space');
  assert.equal(start.readyAt - start.startedAt, 4 * 60000);
  assert.equal(start.end, '30 min without use');
  assert.equal(start.cost, 35 * 0.041667, 'every started minute is billed');
  // Seen serving without a start from here; then paused outside the plugin.
  const seen = { route: 'b', facts: { id: 'your-user/b' } };
  a.track(seen, { phase: 'ready' }, texts);
  a.track(seen, { phase: 'off' }, texts);
  const [outside] = ledger.starts('your-user/b');
  assert.equal(outside.seen, true);
  assert.match(outside.end, /paused outside the plugin/);
  // Nothing opens for a Space that stays off.
  a.track({ route: 'c', facts: { id: 'your-user/c' } }, { phase: 'off' }, texts);
  assert.deepEqual(ledger.starts('your-user/c'), []);
});
