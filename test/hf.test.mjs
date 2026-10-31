import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { HF_API, MAX_FILE_BYTES, createHfClient } from '../src/hf.mjs';

// A local stand-in for the Hugging Face API, on 127.0.0.1 only.
const seen = [];
let server;
let base;
before(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    await new Promise(resolve => req.on('end', resolve));
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const runtime = { stage: 'APP_STARTING', hardware: { current: null, requested: 'a100-large' }, gcTimeout: 3600 };
    if (req.url === '/api/spaces/your-user/your-llm-space/runtime') return json(200, { ...runtime, stage: 'RUNTIME_ERROR', errorMessage: 'CUDA out of memory' });
    if (req.method === 'POST' && req.url === '/api/spaces/your-user/your-llm-space/restart') return json(200, runtime);
    if (req.method === 'POST' && req.url === '/api/spaces/your-user/your-llm-space/pause') return json(200, { ...runtime, stage: 'PAUSED' });
    if (req.method === 'POST' && req.url === '/api/spaces/your-user/your-llm-space/hardware') return json(200, { ...runtime, hardware: { current: null, requested: JSON.parse(body).flavor } });
    if (req.method === 'POST' && req.url === '/api/spaces/your-user/your-llm-space/variables') return json(200, {});
    if (req.method === 'POST' && req.url === '/api/spaces/your-user/not-mine/pause') return json(403, { error: 'forbidden' });
    if (req.method === 'POST' && req.url === '/api/spaces/your-user/not-mine/variables') return json(403, { error: 'forbidden' });
    if (req.url.startsWith('/api/settings/billing/usage-v2?')) return json(200, { usage: { Spaces: [{ label: 'your-user/your-llm-space', quantity: 3, totalCostMicroUSD: 125001 }] } });
    if (req.url === '/api/whoami-v2') return req.headers.authorization === 'Bearer bad' ? json(401, {}) : json(200, { name: 'your-user', auth: { accessToken: { role: 'fineGrained' } } });
    if (req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'open-model-q6' }, { id: 'second' }] });
    if (req.url === '/api/spaces/your-user/your-llm-space') {
      return json(200, {
        id: 'your-user/your-llm-space', sha: 'abc123', host: `${base}`,
        siblings: [{ rfilename: 'README.md' }, { rfilename: 'dsh-hf-spaces.json' }],
        runtime: { stage: 'PAUSED', gcTimeout: 3600 },
      });
    }
    if (req.url === '/api/spaces/your-user/odd-host') return json(200, { sha: 'x', host: 'https://evil.example.com', siblings: [] });
    if (req.url === '/api/spaces/your-user/private') return json(401, { error: 'unauthorized' });
    if (req.url === '/api/spaces/your-user/moved') { res.writeHead(302, { location: 'https://elsewhere.example.com/' }); return res.end(); }
    if (req.url === '/spaces/your-user/your-llm-space/resolve/abc123/dsh-hf-spaces.json') { res.writeHead(200); return res.end('{"schemaVersion":1}'); }
    if (req.url === '/spaces/your-user/your-llm-space/resolve/abc123/huge.json') { res.writeHead(200); return res.end('x'.repeat(MAX_FILE_BYTES + 1)); }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const client = (token = 'test-token') => createHfClient({ apiURL: base, getToken: async () => token });
/** Each credential kind gets its own fake token, to prove which one a request used. */
const byKind = () => createHfClient({ apiURL: base, getToken: async kind => `${kind}-token` });

test('runtime: stage, hardware and error message, read with the inference credential', async () => {
  const runtime = await byKind().getRuntime('your-user/your-llm-space');
  assert.deepEqual(runtime, { stage: 'RUNTIME_ERROR', current: null, requested: 'a100-large', gcTimeout: 3600, error: 'CUDA out of memory' });
  assert.equal(seen.at(-1).auth, 'Bearer inference-token');
});

test('start, pause and hardware are POSTs with the control credential', async () => {
  const hf = byKind();
  assert.equal((await hf.restart('your-user/your-llm-space')).stage, 'APP_STARTING');
  assert.deepEqual([seen.at(-1).method, seen.at(-1).auth], ['POST', 'Bearer control-token']);
  assert.equal((await hf.pause('your-user/your-llm-space')).stage, 'PAUSED');
  assert.equal((await hf.requestHardware('your-user/your-llm-space', 'l40sx1')).requested, 'l40sx1');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { flavor: 'l40sx1' });
  await assert.rejects(hf.pause('your-user/not-mine'), /HTTP 403 \(the control credential cannot change this Space; it needs write access and the Space owner\)/);
});

test('a start variable is a POST of {key, value} with the control credential', async () => {
  const hf = byKind();
  await hf.setVariable('your-user/your-llm-space', 'SPACE_SESSION', '{"id":"x"}');
  const request = seen.at(-1);
  assert.deepEqual([request.method, request.url, request.auth], ['POST', '/api/spaces/your-user/your-llm-space/variables', 'Bearer control-token']);
  assert.deepEqual(JSON.parse(request.body), { key: 'SPACE_SESSION', value: '{"id":"x"}' });
  await assert.rejects(hf.setVariable('your-user/not-mine', 'SPACE_SESSION', 'x'), /setting variable SPACE_SESSION of Space your-user\/not-mine failed: HTTP 403/);
});

test('billing usage: Unix seconds, billing credential; whoami: account and token role', async () => {
  const hf = byKind();
  const body = await hf.getBillingUsage(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31));
  assert.equal(body.usage.Spaces[0].quantity, 3);
  const request = seen.at(-1);
  assert.equal(request.url, `/api/settings/billing/usage-v2?startDate=${Date.UTC(2026, 9, 1) / 1000}&endDate=${Date.UTC(2026, 9, 31) / 1000}`);
  assert.equal(request.auth, 'Bearer billing-token');
  assert.deepEqual(await hf.whoami('control'), { user: 'your-user', role: 'fineGrained' });
  assert.equal(seen.at(-1).auth, 'Bearer control-token');
  await assert.rejects(client('bad').whoami('inference'), /the inference credential was not accepted: HTTP 401/);
});

test('served models: read from the Space address only, with the inference credential', async () => {
  assert.deepEqual(await byKind().listServedModels(`${base}/v1`), ['open-model-q6', 'second']);
  assert.equal(seen.at(-1).auth, 'Bearer inference-token');
  const real = createHfClient({ getToken: async () => 'must-not-leave' });
  await assert.rejects(real.listServedModels('https://proxy.example.com/v1'), /must be https:\/\/<subdomain>\.hf\.space/);
});

test('reads what the plugin needs from the Space API, with the token', async () => {
  const space = await client().getSpace('your-user/your-llm-space');
  assert.deepEqual(space, { sha: 'abc123', host: base, files: ['README.md', 'dsh-hf-spaces.json'], stage: 'PAUSED', gcTimeout: 3600 });
  assert.equal(seen.at(-1).auth, 'Bearer test-token');
});

test('reads a Space file pinned to a revision; a missing file is undefined', async () => {
  assert.equal(await client().readSpaceFile('your-user/your-llm-space', 'abc123', 'dsh-hf-spaces.json'), '{"schemaVersion":1}');
  assert.equal(await client().readSpaceFile('your-user/your-llm-space', 'abc123', 'other.json'), undefined);
});

test('a Space file larger than the limit is refused, not buffered', async () => {
  await assert.rejects(client().readSpaceFile('your-user/your-llm-space', 'abc123', 'huge.json'), /larger than 65536 bytes/);
});

test('no token: no Authorization header is sent', async () => {
  await createHfClient({ apiURL: base, getToken: async () => undefined }).getSpace('your-user/your-llm-space');
  assert.equal(seen.at(-1).auth, undefined);
});

test('errors say what to check, and never contain the token', async () => {
  await assert.rejects(client('secret-value').getSpace('your-user/private'), error => {
    assert.match(error.message, /HTTP 401 \(the inference credential is missing or was not accepted\)/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

test('a redirect is refused instead of followed with the token', async () => {
  await assert.rejects(client().getSpace('your-user/moved'), /redirect, which is not followed/);
});

test('an unexpected Space address is refused', async () => {
  await assert.rejects(client().getSpace('your-user/odd-host'), /unexpected address; set `baseURL`/);
});

test('the API address is Hugging Face, or this machine for tests', () => {
  assert.doesNotThrow(() => createHfClient({ apiURL: HF_API }));
  assert.throws(() => createHfClient({ apiURL: 'https://example.com' }), /hfApiURL must be https:\/\/huggingface\.co/);
});
