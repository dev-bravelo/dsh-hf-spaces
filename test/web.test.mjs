import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ACTION_PATH, STATE_PATH, attachWeb } from '../src/web.mjs';

/** A fake Harness context: the two services the routes need, and the handlers they register. */
function harness({ rejection } = {}) {
  const handlers = new Map();
  const calls = [];
  const sub = {
    effect: fn => fn(),
    webServer: { register: ({ kind, path, handler }) => { handlers.set(path, { kind, handler }); return () => {}; } },
    connection: { requestRejection: () => rejection },
  };
  const control = {
    views: async () => [{ route: 'my-llm', label: 'My LLM', phase: 'off' }],
    run: async ({ rawInput }) => { calls.push(rawInput); return { kind: 'success', text: `did ${rawInput}` }; },
  };
  attachWeb({ ctx: { inject: (names, cb) => { assert.deepEqual(names, ['webServer', 'connection']); cb(sub); } }, control, locale: 'pt-BR' });
  return { handlers, calls };
}

async function call(handler, { method = 'GET', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  const res = { headers: {}, statusCode: 200, body: '', setHeader(k, v) { this.headers[k] = v; }, end(text = '') { this.body = text; } };
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
}

test('state: exact route, GET only, the views and the locale', async () => {
  const { handlers } = harness();
  assert.equal(handlers.get(STATE_PATH).kind, 'exact');
  const ok = await call(handlers.get(STATE_PATH).handler);
  assert.deepEqual(ok, { status: 200, json: { locale: 'pt-BR', spaces: [{ route: 'my-llm', label: 'My LLM', phase: 'off' }] } });
  assert.equal((await call(handlers.get(STATE_PATH).handler, { method: 'POST' })).status, 405);
});

test('action: on, off and extend become the /space command; anything else is refused', async () => {
  const { handlers, calls } = harness();
  const action = handlers.get(ACTION_PATH).handler;
  assert.equal((await call(action, { method: 'POST', body: { route: 'my-llm', action: 'on' } })).json.text, 'did on my-llm');
  await call(action, { method: 'POST', body: { route: 'my-llm', action: 'extend' } });
  await call(action, { method: 'POST', body: { route: 'my-llm', action: 'off' } });
  assert.deepEqual(calls, ['on my-llm', '+ my-llm', 'off my-llm']);
  assert.equal((await call(action, { method: 'POST', body: { route: 'my-llm', action: 'delete' } })).status, 400);
  assert.equal((await call(action, { method: 'POST', body: { route: '../x', action: 'on' } })).status, 400);
  assert.equal((await call(action, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await call(action, { method: 'POST', body: 'x'.repeat(5000) })).status, 400, 'a large body is refused');
  assert.equal((await call(action)).status, 405);
});

test('every route is guarded: a rejected request gets the guard status and nothing runs', async () => {
  const { handlers, calls } = harness({ rejection: 403 });
  assert.deepEqual(await call(handlers.get(STATE_PATH).handler), { status: 403, json: undefined });
  assert.equal((await call(handlers.get(ACTION_PATH).handler, { method: 'POST', body: { route: 'my-llm', action: 'on' } })).status, 403);
  assert.deepEqual(calls, []);
});
