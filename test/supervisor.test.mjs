import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupervisor, describeState, isPaused, stageKind } from '../src/supervisor.mjs';

/**
 * An in-memory Space that behaves like the Hugging Face API: a restart boots after `bootPolls`
 * runtime reads, a pause is confirmed after `pausePolls` reads.
 */
function fakeSpace({ stage = 'PAUSED', current = null, requested = 'a100-large', serves = ['open-model'], bootPolls = 2, pausePolls = 1,
  bootsInto = 'RUNNING', neverPaused = false, runtimeErrors = 0, modelsStatus } = {}) {
  const calls = [];
  let rt = { stage, current, requested };
  let up = stage === 'RUNNING';
  let untilUp = Infinity;
  let untilPaused = Infinity;
  let errorsLeft = runtimeErrors;
  return {
    calls,
    async getRuntime() {
      calls.push('runtime');
      if (rt.stage === 'APP_STARTING' && errorsLeft-- > 0) throw new Error('network');
      if (--untilUp <= 0) {
        untilUp = Infinity;
        rt = { ...rt, stage: bootsInto, ...(bootsInto === 'RUNNING' ? { current: rt.requested } : { error: 'CUDA out of memory' }) };
        up = bootsInto === 'RUNNING';
      }
      if (--untilPaused <= 0 && !neverPaused) {
        untilPaused = Infinity;
        rt = { ...rt, stage: 'PAUSED', current: null };
      }
      return { ...rt };
    },
    async restart() {
      calls.push('restart');
      rt = { ...rt, stage: 'APP_STARTING' };
      untilUp = bootPolls;
      return { ...rt };
    },
    async requestHardware(id, flavor) {
      calls.push(`hardware ${flavor}`);
      rt = { ...rt, stage: 'APP_STARTING', requested: flavor };
      untilUp = bootPolls;
      return { ...rt };
    },
    async pause() {
      calls.push('pause');
      up = false;
      untilUp = Infinity;
      rt = { ...rt, stage: 'PAUSED' }; // hardware stays attached until Hugging Face confirms
      untilPaused = pausePolls;
      return { ...rt };
    },
    async listServedModels() {
      calls.push('models');
      if (!up) throw new Error('connection refused');
      if (modelsStatus) throw Object.assign(new Error(`HTTP ${modelsStatus}`), { status: modelsStatus });
      return serves;
    },
    /** Something outside the plugin pauses the Space (the web page, or its sleep time). */
    pauseOutside() {
      up = false;
      rt = { ...rt, stage: 'PAUSED', current: null };
    },
  };
}

/** A supervisor on a fake clock: every sleep advances time instantly. */
function supervised(client, space = {}) {
  let t = 0;
  const states = [];
  const supervisor = createSupervisor({
    space: { id: 'your-user/your-llm-space', baseURL: 'https://x.hf.space/v1', modelIds: ['open-model'], readyTimeoutMinutes: 15, ...space },
    client,
    onChange: s => states.push(s.phase),
    now: () => t,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); t += ms; await Promise.resolve(); },
  });
  return { supervisor, states, clock: () => t };
}

test('stages are grouped by what the supervisor does with them', () => {
  assert.equal(stageKind('PAUSED'), 'stopped');
  assert.equal(stageKind('SLEEPING'), 'stopped');
  assert.equal(stageKind('RUNNING'), 'running');
  assert.equal(stageKind('RUNNING_BUILDING'), 'running');
  assert.equal(stageKind('APP_STARTING'), 'starting');
  assert.equal(stageKind('RUNTIME_ERROR'), 'error');
  assert.equal(stageKind('DELETING'), 'unknown');
  assert.equal(stageKind(undefined), 'unknown');
  assert.equal(isPaused({ stage: 'PAUSED', current: null }), true);
  assert.equal(isPaused({ stage: 'PAUSED', current: 'a100-large' }), false, 'hardware still attached');
});

test('start: a paused Space is restarted and is ready only when its server lists the model', async () => {
  const client = fakeSpace();
  const { supervisor, states } = supervised(client);
  const state = await supervisor.start();
  assert.equal(state.phase, 'ready');
  assert.equal(state.hardware, 'a100-large');
  assert.deepEqual(states, ['starting', 'ready']);
  assert.equal(client.calls.filter(c => c === 'restart').length, 1);
  assert.equal(describeState(state), 'ready on a100-large');
});

test('start: a configured hardware different from the requested one is requested instead of a plain restart', async () => {
  const client = fakeSpace({ requested: 'l40sx1' });
  const { supervisor } = supervised(client, { hardware: 'a100-large' });
  assert.equal((await supervisor.start()).phase, 'ready');
  assert.ok(client.calls.includes('hardware a100-large'));
  assert.ok(!client.calls.includes('restart'));
});

test('start: a Space already serving is ready at once, with no restart', async () => {
  const client = fakeSpace({ stage: 'RUNNING', current: 'a100-large' });
  const { supervisor } = supervised(client);
  assert.equal((await supervisor.start()).phase, 'ready');
  assert.ok(!client.calls.includes('restart'));
});

test('start: calls while a start runs join it instead of starting twice', async () => {
  const client = fakeSpace();
  const { supervisor } = supervised(client);
  const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
  assert.equal(a.phase, 'ready');
  assert.equal(b.phase, 'ready');
  assert.equal(client.calls.filter(c => c === 'restart').length, 1);
});

test('start: a passing network error while waiting does not fail the start', async () => {
  const client = fakeSpace({ runtimeErrors: 1, bootPolls: 3 });
  const { supervisor } = supervised(client);
  assert.equal((await supervisor.start()).phase, 'ready');
});

test('failed start: an error stage pauses the Space for safety and says why', async () => {
  const client = fakeSpace({ bootsInto: 'RUNTIME_ERROR' });
  const { supervisor, states } = supervised(client);
  const state = await supervisor.start();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /RUNTIME_ERROR: CUDA out of memory/);
  assert.equal(state.paused, true);
  assert.ok(client.calls.includes('pause'));
  assert.deepEqual(states, ['starting', 'stopping', 'failed']);
});

test('failed start: not ready in time pauses the Space', async () => {
  const client = fakeSpace({ bootPolls: Infinity });
  const { supervisor, clock } = supervised(client, { readyTimeoutMinutes: 2 });
  const state = await supervisor.start();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /^not ready after 2 min; see the Space run log on Hugging Face, or raise start\.readyTimeoutMinutes/);
  assert.equal(state.paused, true);
  assert.ok(clock() >= 2 * 60000);
});

test('failed start: a refused credential ends the wait at once instead of billing until the timeout', async () => {
  const client = fakeSpace({ modelsStatus: 401 });
  const { supervisor, clock } = supervised(client);
  const state = await supervisor.start();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /refused the inference credential \(HTTP 401\); set one that can read the Space/);
  assert.equal(state.paused, true);
  assert.ok(clock() < 60000, 'stopped within the first minute, not after 15');
});

test('failed start: a Space started elsewhere is reported but left running', async () => {
  const client = fakeSpace({ stage: 'APP_STARTING', bootPolls: Infinity });
  const { supervisor } = supervised(client, { readyTimeoutMinutes: 1 });
  const state = await supervisor.start();
  assert.equal(state.phase, 'failed');
  assert.match(state.note, /left as it is/);
  assert.ok(!client.calls.includes('restart'));
  assert.ok(!client.calls.includes('pause'), 'not paused: this start did not begin it');
});

test('start after an outside pause reads the Space again and restarts it', async () => {
  const client = fakeSpace();
  const { supervisor } = supervised(client);
  assert.equal((await supervisor.start()).phase, 'ready');
  client.pauseOutside();
  assert.equal((await supervisor.start()).phase, 'ready');
  assert.equal(client.calls.filter(c => c === 'restart').length, 2);
});

test('a stop that arrives while a failed start is pausing wins: the end state is off', async () => {
  const client = fakeSpace({ bootsInto: 'RUNTIME_ERROR', pausePolls: 3 });
  let t = 0;
  let stopping;
  let pressed = false;
  const supervisor = createSupervisor({
    space: { id: 'your-user/your-llm-space', baseURL: 'https://x.hf.space/v1', modelIds: ['open-model'], readyTimeoutMinutes: 15 },
    client,
    now: () => t,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); t += ms; await Promise.resolve(); },
    // The user presses Stop the moment the failed start begins its safety pause.
    onChange: s => {
      if (s.phase !== 'stopping' || pressed) return;
      pressed = true;
      stopping = supervisor.stop('stopped by the user');
    },
  });
  await supervisor.start();
  const state = await stopping;
  assert.equal(state.phase, 'off');
  assert.equal(supervisor.state().phase, 'off', 'the cancelled start did not overwrite the stop');
});

test('a stop asked from inside a state change joins the stop already running', async () => {
  const client = fakeSpace({ stage: 'RUNNING', current: 'a100-large' });
  let again;
  const supervisor = createSupervisor({
    space: { id: 'your-user/your-llm-space', baseURL: 'https://x.hf.space/v1', modelIds: ['open-model'], readyTimeoutMinutes: 15 },
    client,
    sleep: async () => {},
    onChange: s => { if (s.phase === 'stopping' && !again) again = supervisor.stop('second press'); },
  });
  const first = supervisor.stop('first press');
  assert.equal((await first).phase, 'off');
  assert.equal(await again, await first, 'the second press shares the first stop');
  assert.equal(client.calls.filter(c => c === 'pause').length, 1);
});

test('stop on a Space that is already paused sends no pause', async () => {
  const client = fakeSpace();
  const { supervisor } = supervised(client);
  assert.equal((await supervisor.stop('idle')).phase, 'off');
  assert.ok(!client.calls.includes('pause'));
});

test('a refused pause request is reported as a possible cost', async () => {
  const client = fakeSpace({ stage: 'RUNNING', current: 'a100-large' });
  client.pause = async () => { throw Object.assign(new Error('pausing Space failed: HTTP 403'), { status: 403 }); };
  const state = await supervised(client).supervisor.stop('stopped by the user');
  assert.equal(state.phase, 'failed');
  assert.equal(state.paused, false);
  assert.match(state.warning, /the GPU may still bill/);
});

test('failed start: a server that lists other models is a configuration problem, reported at once', async () => {
  const client = fakeSpace({ serves: ['another-model'] });
  const { supervisor } = supervised(client);
  const state = await supervisor.start();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /the Space serves another-model, not open-model; fix the model ids/);
  assert.equal(state.paused, true);
});

test('stop: pauses and waits for Hugging Face to confirm', async () => {
  const client = fakeSpace({ stage: 'RUNNING', current: 'a100-large', pausePolls: 2 });
  const { supervisor, states } = supervised(client);
  const state = await supervisor.stop('stopped by the user');
  assert.equal(state.phase, 'off');
  assert.equal(state.reason, 'stopped by the user');
  assert.deepEqual(states, ['stopping', 'off']);
});

test('stop: an unconfirmed pause is reported as a possible cost, not as off', async () => {
  const client = fakeSpace({ stage: 'RUNNING', current: 'a100-large', neverPaused: true });
  const { supervisor } = supervised(client);
  const state = await supervisor.stop('idle');
  assert.equal(state.phase, 'failed');
  assert.equal(state.paused, false);
  assert.match(state.warning, /the GPU may still bill/);
});

test('stop during a start cancels the start and pauses', async () => {
  const client = fakeSpace({ bootPolls: Infinity });
  const { supervisor } = supervised(client);
  const starting = supervisor.start();
  await Promise.resolve();
  const stopped = await supervisor.stop('stopped by the user');
  await starting;
  assert.equal(stopped.phase, 'off');
  assert.equal(supervisor.state().phase, 'off');
});

test('check: reads the state without starting or stopping anything', async () => {
  assert.equal((await supervised(fakeSpace()).supervisor.check()).phase, 'off');
  assert.equal((await supervised(fakeSpace({ stage: 'RUNNING', current: 'a100-large' })).supervisor.check()).phase, 'ready');
  const broken = await supervised(fakeSpace({ stage: 'RUNTIME_ERROR' })).supervisor.check();
  assert.equal(broken.phase, 'failed');
  const client = fakeSpace();
  await supervised(client).supervisor.check();
  assert.deepEqual(client.calls, ['runtime']);
});
