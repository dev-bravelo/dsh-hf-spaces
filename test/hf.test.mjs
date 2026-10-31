import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { HF_API, MAX_FILE_BYTES, createHfClient } from '../src/hf.mjs';

// A local stand-in for the Hugging Face API, on 127.0.0.1 only.
const seen = [];
let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
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
