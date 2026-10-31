// Runtime tests of the chat gate on an installed DeepSeek Harness: real agent loop and jobs
// registry; one local server plays both Hugging Face and the Space. No GPU, no network beyond
// 127.0.0.1. Skipped under plain `node --test` (AGENTS.md, section 6).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.DSH_TEST_RUNTIME_ROOT;
if (!root) {
  test('chat gate on an installed Harness', { skip: 'set DSH_TEST_RUNTIME_ROOT and run with the Harness Electron (AGENTS.md, section 6)' }, () => {});
} else {
  const { asPlugin, environment, runtimePackage } = await import('./runtime-loader.mjs');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plugin = asPlugin(await import(pathToFileURL(path.join(repo, 'src', 'index.mjs')).href));
  const llm = runtimePackage('@deepseek-ai/dsh-llm');
  const MODEL = 'open-model';
  const SPACE = 'your-user/chat-space';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (what, check, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };

  /** Hugging Face and the Space in one local server. A restart boots after `bootReads` state reads. */
  async function fakeHub({ stage = 'PAUSED', bootReads = 2, bootsInto = 'RUNNING', modelsDown = 0, refuse, logLines = [], probeDelayMs = 0 } = {}) {
    const hub = { stage, current: stage === 'RUNNING' ? 'a100-large' : null, chats: [], probes: [], calls: [], left: Infinity, modelsDown };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        hub.calls.push(`${req.method} ${req.url}`);
        const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const runtime = () => ({ stage: hub.stage, hardware: { current: hub.current, requested: 'a100-large' } });
        if (req.url === `/api/spaces/${SPACE}`) return json(200, { sha: 'rev1', host: hub.api, siblings: [] });
        if (req.url === '/api/spaces/hardware') return json(200, [{ name: 'a100-large', unitCostUSD: 0.041667, unitLabel: 'minute' }]);
        if (req.url === `/api/spaces/${SPACE}/runtime`) {
          if (--hub.left <= 0) { hub.left = Infinity; hub.stage = bootsInto; hub.current = bootsInto === 'RUNNING' ? 'a100-large' : null; }
          return json(200, runtime());
        }
        if (req.method === 'POST' && req.url === `/api/spaces/${SPACE}/restart`) { hub.stage = 'APP_STARTING'; hub.left = bootReads; return json(200, runtime()); }
        if (req.method === 'POST' && req.url === `/api/spaces/${SPACE}/pause`) { hub.stage = 'PAUSED'; hub.current = null; hub.left = Infinity; return json(200, runtime()); }
        if (req.url.startsWith(`/api/spaces/${SPACE}/logs/run`)) {
          // The run log as server-sent events; a paused Space sends nothing (verified 2026-10-30).
          if (hub.stage === 'PAUSED') return;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const line of logLines) res.write(`data: ${JSON.stringify({ data: line, timestamp: '' })}\n\n`);
          return res.end();
        }
        if (hub.stage !== 'RUNNING') { res.writeHead(503); return res.end(); }
        if (req.url === '/v1/models') {
          if (hub.modelsDown-- > 0) { res.writeHead(502); return res.end(); } // a passing gateway error
          return json(200, { object: 'list', data: [{ id: MODEL }] });
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions' && JSON.parse(body).stream !== true) {
          // The plugin's warm-up and effort check: one-token requests, kept apart from real chats.
          const probe = JSON.parse(body);
          hub.probes.push(probe);
          const answer = () => (refuse && probe.reasoning_effort === refuse
            ? json(500, { error: { message: `unknown reasoning effort ${refuse}` } })
            : json(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'o' }, finish_reason: 'length' }] }));
          if (probeDelayMs) return void setTimeout(answer, probeDelayMs);
          return answer();
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          hub.chats.push(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta, finish, usage) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL,
            choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
          res.write(chunk({ role: 'assistant', content: 'Hi! How can I help?' }, null));
          res.write(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }));
          return res.end('data: [DONE]\n\n');
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    hub.api = `http://127.0.0.1:${server.address().port}`;
    hub.close = () => new Promise(resolve => server.close(resolve));
    return hub;
  }

  async function setup(t, hubOptions, { credentials, start, stop, reasoning = { off: 'none', medium: 'medium' } } = {}) {
    process.env.TEST_HF_READ = 'test-token'; // fake: tests never use a real credential
    const hub = await fakeHub(hubOptions);
    const env = await environment({ agents: true });
    const { ctx } = env;
    await ctx.plugin(plugin, {
      credentials: { inference: 'TEST_HF_READ', control: 'TEST_HF_READ', billing: 'TEST_HF_READ', ...credentials },
      hfApiURL: hub.api,
      pollSeconds: 1,
      spaces: [{ id: SPACE, label: 'Chat LLM', route: 'chat-llm', ...(start ? { start } : {}), ...(stop ? { stop } : {}), models: [{ id: MODEL, name: 'Open Model', reasoning }] }],
    });
    await until('route registered', () => ctx.llm.listProviders().some(p => p.id === 'chat-llm'));
    const sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { agent } = await ctx.agents.create({ sessionId, agentOptions: { provider: 'chat-llm', model: MODEL } });
    const send = text => agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
    const texts = type => agent.session.snapshotEvents().filter(e => e.type === type)
      .flatMap(e => (e.data.message ?? e.data).content ?? []).filter(b => b.type === 'text').map(b => b.text);
    const jobs = () => ctx.jobs.list(sessionId).filter(job => job.kind === 'hf-space');
    const command = async line => (await ctx.commands.execute(agent, line, [], new AbortController().signal)).result;
    t.after(async () => {
      await env.dispose();
      await hub.close();
      delete process.env.TEST_HF_READ;
    });
    return { ctx, hub, agent, sessionId, send, texts, jobs, command };
  }

  test('a message to a stopped Space starts it, shows a progress job and resumes quoting the user', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: 3 });
    x.send('hello there');
    await x.agent.whenIdle();
    assert.match(x.texts('assistant/message').at(-1), /^🔌 Chat LLM was off\. The dsh-hf-spaces plugin is starting/);
    assert.match(x.texts('assistant/message').at(-1), /under "background job" \(task "Starting Chat LLM"\)/);
    const [progress] = await until('progress job', () => x.jobs().length && x.jobs());
    assert.equal(progress.label, 'Starting Chat LLM');
    await until('Space ready and session resumed', () => x.hub.chats.length > 0);
    await x.agent.whenIdle();
    const settled = x.ctx.jobs.get(progress.id, x.sessionId);
    assert.equal(settled.status, 'completed');
    assert.match(settled.detail ?? '', /^Chat LLM ready in /);
    // The only request to the Space is the resumed turn, and it quotes the waiting message.
    assert.equal(x.hub.chats.length, 1);
    const resumed = x.hub.chats[0].messages.filter(m => m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.match(resumed, /Automatic notice from the dsh-hf-spaces plugin/);
    assert.match(resumed, /«hello there»/);
    assert.ok(x.hub.calls.includes(`POST /api/spaces/${SPACE}/restart`));
    // Woken once by the plugin; no "background job … finished" notice reached the model.
    await sleep(500);
    assert.equal(x.texts('user/message').filter(text => /background job/.test(text) && !/dsh-hf-spaces/.test(text)).length, 0);
    assert.equal(x.texts('user/message').filter(text => /Automatic notice from the dsh-hf-spaces plugin/.test(text)).length, 1);
    assert.equal(x.texts('assistant/message').at(-1), 'Hi! How can I help?');
  });

  test('a message to a Space that already serves goes straight to it', { timeout: 30000 }, async t => {
    const x = await setup(t, { stage: 'RUNNING' });
    x.send('hello');
    await until('answer', () => x.hub.chats.length > 0);
    await x.agent.whenIdle();
    assert.equal(x.texts('assistant/message').at(-1), 'Hi! How can I help?');
    assert.ok(!x.hub.calls.some(call => call.endsWith('/restart')));
    assert.equal(x.jobs().length, 0);
  });

  test('a failed start opens no chat turn; the next message explains the wait', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: 2, bootsInto: 'RUNTIME_ERROR' });
    x.send('first');
    await x.agent.whenIdle();
    const [progress] = await until('progress job', () => x.jobs().length && x.jobs());
    await until('start failed', () => x.ctx.jobs.get(progress.id, x.sessionId).status === 'failed');
    assert.match(x.ctx.jobs.get(progress.id, x.sessionId).detail, /Chat LLM could not be started: the Space reported RUNTIME_ERROR/);
    assert.ok(x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`), 'the failed start was paused');
    await sleep(500);
    assert.equal(x.texts('assistant/message').length, 1, 'no turn was opened for the failure');
    x.send('second');
    await x.agent.whenIdle();
    assert.match(x.texts('assistant/message').at(-1), /could not be started.*Try again in a few minutes\.$/s);
    assert.equal(x.hub.calls.filter(call => call.endsWith('/restart')).length, 1, 'no automatic start during the cooldown');
  });

  test('the stop control of the progress job pauses a starting Space, without a cooldown or a turn', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: Infinity });
    x.send('hello');
    await x.agent.whenIdle();
    const [progress] = await until('progress job', () => x.jobs().length && x.jobs());
    await until('Space starting', () => x.hub.calls.includes(`POST /api/spaces/${SPACE}/restart`));
    assert.equal(x.ctx.jobs.kill(progress.id, x.sessionId, 'cancelled by the user'), 'requested');
    await until('job killed', () => x.ctx.jobs.get(progress.id, x.sessionId).status === 'killed');
    await until('Space paused', () => x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`));
    await sleep(300);
    assert.equal(x.texts('assistant/message').length, 1, 'no turn was opened');
    // A user stop is not a failure: the next message starts the Space again, with no cooldown.
    x.send('again');
    await x.agent.whenIdle();
    assert.match(x.texts('assistant/message').at(-1), /^🔌 Chat LLM was off/);
  });

  test('a stop pressed before the Space began starting cancels the start and sends no pause', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: Infinity });
    x.send('hello');
    await x.agent.whenIdle();
    const [progress] = await until('progress job', () => x.jobs().length && x.jobs());
    x.ctx.jobs.kill(progress.id, x.sessionId, 'cancelled by the user');
    await until('job killed', () => x.ctx.jobs.get(progress.id, x.sessionId).status === 'killed');
    await sleep(1500);
    // Either it was cancelled before the restart (no pause needed), or it was paused after it.
    const restarted = x.hub.calls.includes(`POST /api/spaces/${SPACE}/restart`);
    assert.equal(x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`), restarted);
  });

  test('without the inference credential nothing starts, and the notice says what to add', { timeout: 30000 }, async t => {
    const x = await setup(t, {}, { credentials: { inference: 'MISSING_READ_TOKEN' } });
    x.send('hello');
    await x.agent.whenIdle();
    assert.match(x.texts('assistant/message').at(-1), /the credential MISSING_READ_TOKEN is missing.*Add it to the vault under that name/s);
    assert.ok(!x.hub.calls.some(call => call.endsWith('/restart')), 'the GPU was never started');
  });

  test('with automatic start off, the notice says how to start the Space', { timeout: 30000 }, async t => {
    const x = await setup(t, {}, { start: { automatic: false } });
    x.send('hello');
    await x.agent.whenIdle();
    assert.match(x.texts('assistant/message').at(-1), /automatic start is disabled.*\/space on chat-llm/s);
    assert.ok(!x.hub.calls.some(call => call.endsWith('/restart')));
  });

  test('a running Space whose model list fails for a moment is joined, not called off or restarted', { timeout: 60000 }, async t => {
    const x = await setup(t, { stage: 'RUNNING', modelsDown: 2 });
    x.send('hello');
    await x.agent.whenIdle();
    assert.match(x.texts('assistant/message').at(-1), /^⏳ Chat LLM is starting on Hugging Face/);
    await until('session resumed', () => x.hub.chats.length > 0);
    assert.ok(!x.hub.calls.some(call => call.endsWith('/restart')), 'not restarted');
  });


  test('/space status, on, +N and off act without any model request', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: 2 });
    assert.ok(x.ctx.commands.list(x.agent).some(c => c.name === 'space'));
    assert.match((await x.command('/space status')).text, /^Chat LLM \(chat-llm\): off\./);
    const on = await x.command('/space on');
    assert.equal(on.kind, 'success', on.text);
    assert.match(on.text, /^Starting Chat LLM/);
    assert.match(on.text, /Nothing was sent to the model\./);
    const [progress] = await until('progress job of /space on', () => x.jobs().length && x.jobs());
    await until('start done', () => x.ctx.jobs.get(progress.id, x.sessionId).status === 'completed');
    assert.match((await x.command('/space on')).text, /already serving/);
    const status = (await x.command('/space status')).text;
    assert.match(status, /serving on a100-large\. On for \d+ s, estimated cost US\$ 0\.04\. Stops at \d{2}:\d{2}, or earlier after 30 min without use\./);
    assert.match((await x.command('/space +30')).text, /^Time limit extended by 30 min: Chat LLM stops at \d{2}:\d{2}/);
    const off = await x.command('/space off');
    assert.equal(off.kind, 'success', off.text);
    assert.match(off.text, /^Chat LLM paused; billing stopped\. Estimated cost of this start: US\$ 0\.04\.$/);
    assert.match((await x.command('/space off')).text, /already off/);
    assert.equal((await x.command('/space start everything')).kind, 'error');
    assert.match((await x.command('/space on other-route')).text, /No Space uses the route "other-route"/);
    await sleep(300);
    assert.equal(x.hub.chats.length, 0, 'no model request at all');
    assert.equal(x.texts('user/message').length, 0, 'no wake and no job notice');
  });

  test('the idle rule pauses a Space this Harness saw serving', { timeout: 60000 }, async t => {
    const x = await setup(t, { stage: 'RUNNING' }, { stop: { idleMinutes: 0.05 } });
    x.send('hello');
    await until('answer', () => x.hub.chats.length > 0);
    await x.agent.whenIdle();
    await until('idle pause', () => x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`), 20000);
    assert.match((await x.command('/space status')).text, /off\. .*Last: 0\.05 min without use\./);
  });
  test('the time limit pauses a start made here, counted from the start', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: 1 }, { stop: { idleMinutes: 0, sessionMinutes: 0.1, warnMinutes: 0.05 } });
    const on = await x.command('/space on');
    assert.equal(on.kind, 'success', on.text);
    await until('limit pause', () => x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`), 30000);
    assert.match((await x.command('/space status')).text, /off\. .*Last: time limit of 0\.1 min\./);
  });

  test('/space off reads the Space: one started elsewhere after the plugin began is paused, not called off', { timeout: 60000 }, async t => {
    const x = await setup(t, { stage: 'PAUSED' });
    await sleep(300); // the startup check saw it paused
    x.hub.stage = 'RUNNING'; // started on the Hugging Face website
    x.hub.current = 'a100-large';
    assert.match((await x.command('/space status')).text, /serving on a100-large/);
    const off = await x.command('/space off');
    assert.equal(off.kind, 'success', off.text);
    assert.match(off.text, /^Chat LLM paused; billing stopped\./);
    assert.ok(x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`));
    assert.match((await x.command('/space off')).text, /already off/);
  });
  test('progress follows the run log (copy bytes), then the warm-up checks each effort level', { timeout: 60000 }, async t => {
    const copy = 'SPACE_EVENT {"stage": "copy_progress", "artifact": "model", "bytes": 11000000000, "total_bytes": 22000000000, "seconds": 50}';
    const x = await setup(t, { bootReads: 4, refuse: 'high', logLines: ['booting', copy] }, { reasoning: { off: 'none', medium: 'medium', high: 'high' } });
    x.send('hello');
    await x.agent.whenIdle();
    const [progress] = await until('progress job', () => x.jobs().length && x.jobs());
    const lines = new Set();
    await until('session resumed', () => {
      const view = x.ctx.jobs.get(progress.id, x.sessionId);
      if (view.progress) lines.add(view.progress);
      return x.hub.chats.length > 0;
    });
    assert.ok([...lines].some(line => /^Copying the model · \d+% · about .+ left$/.test(line)), [...lines].join(' | '));
    // One minimal request per configured level, in order; they also warmed the model.
    // A refused level is asked twice (a single 500 may be a passing overload).
    assert.deepEqual(x.hub.probes.map(p => p.reasoning_effort), ['none', 'medium', 'high', 'high']);
    assert.ok(x.hub.probes.every(p => p.max_tokens === 1 && p.model === MODEL));
    assert.equal(x.hub.chats.length, 1, 'the probes are not counted as the conversation');
    assert.match((await x.command('/space status')).text, /Note: the Space refused the effort levels open-model: high; remove them from "reasoning"/);
  });
  test('a second start in the same Harness warms up with one request, without checking every level again', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: 1 }, { reasoning: { off: 'none', low: 'low', medium: 'medium' } });
    await x.command('/space on');
    await until('first start ready', () => x.hub.probes.length === 3 && x.ctx.jobs.list(x.sessionId).every(j => j.status !== 'running'));
    await x.command('/space off');
    await x.command('/space on');
    await until('second start ready', () => x.ctx.jobs.list(x.sessionId).filter(j => j.status === 'completed').length === 2);
    assert.equal(x.hub.probes.length, 4, 'three to check the levels, then one to warm up');
  });

  test('a stop pressed during the warm-up ends it: no more requests, the Space is paused', { timeout: 60000 }, async t => {
    const x = await setup(t, { bootReads: 1, probeDelayMs: 800 }, { reasoning: { off: 'none', low: 'low', medium: 'medium' } });
    x.send('hello');
    await x.agent.whenIdle();
    const [progress] = await until('progress job', () => x.jobs().length && x.jobs());
    await until('warm-up began', () => x.hub.probes.length >= 1);
    x.ctx.jobs.kill(progress.id, x.sessionId, 'cancelled by the user');
    await until('Space paused', () => x.hub.calls.includes(`POST /api/spaces/${SPACE}/pause`));
    await sleep(2000);
    assert.ok(x.hub.probes.length < 3, `only the requests already sent: ${x.hub.probes.length}`);
    assert.equal(x.hub.chats.length, 0, 'the session was not resumed');
  });
}
