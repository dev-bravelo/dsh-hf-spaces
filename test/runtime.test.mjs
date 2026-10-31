// Runtime tests on an installed DeepSeek Harness (AGENTS.md, section 6). They are skipped under
// plain `node --test`, which has no Harness to mount.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.DSH_TEST_RUNTIME_ROOT;
if (!root) {
  test('runtime tests on an installed Harness', { skip: 'set DSH_TEST_RUNTIME_ROOT and run with the Harness Electron (AGENTS.md, section 6)' }, () => {});
} else {
  const { asPlugin, environment, runtimeURL } = await import('./runtime-loader.mjs');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifestJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const plugin = await import(pathToFileURL(path.join(repo, 'src', 'index.mjs')).href);
  // The installed Harness's own admission rule, not a copy of it.
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(runtimeURL('@deepseek-ai/dsh-app-boot'));

  // A local stand-in for the Hugging Face API, with one Space that has a manifest and one without.
  const seen = [];
  let server;
  let api;
  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/api/spaces/your-user/with-manifest') {
        return json({ sha: 'rev1', host: api, siblings: [{ rfilename: 'dsh-hf-spaces.json' }], runtime: { stage: 'PAUSED', gcTimeout: 3600 } });
      }
      if (req.url === '/api/spaces/your-user/no-manifest') return json({ sha: 'rev2', host: api, siblings: [{ rfilename: 'README.md' }] });
      if (req.url === '/spaces/your-user/with-manifest/resolve/rev1/dsh-hf-spaces.json') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          schemaVersion: 1,
          models: [{ id: 'open-model-q6', name: 'Open Model 27B', contextWindow: 262144, maxTokens: 32768, reasoning: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' } }],
        }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${server.address().port}`;
    process.env.TEST_HF_READ = 'test-token'; // fake: tests never use a real credential
  });
  after(() => {
    delete process.env.TEST_HF_READ;
    server.close();
  });

  const routeIds = ctx => ctx.llm.listProviders().map(p => p.id);
  async function waitForRoute(ctx, route, present = true) {
    for (let i = 0; i < 100; i++) {
      if (routeIds(ctx).includes(route) === present) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`route ${route} ${present ? 'never appeared' : 'never went away'}; routes: ${routeIds(ctx).join(', ')}`);
  }

  test('admission: the installed Harness admits the package and refuses it outside its range', () => {
    assert.equal(evaluatePluginCompatibility(manifestJson, {}, getDshRuntimeVersion()), undefined);
    for (const version of ['0.2.1-rc.2', '0.3.0-alpha.1', '0.3.0']) {
      const issue = evaluatePluginCompatibility(manifestJson, {}, version);
      assert.ok(issue, version);
      assert.deepEqual(Object.keys(issue.requirements), ['engines.dsh'], version);
    }
  });

  test('a configured Space appears in the model list with its name and ordered effort levels', async () => {
    const { ctx, dispose } = await environment();
    const readsBefore = seen.length;
    try {
      const fiber = ctx.plugin(asPlugin(plugin), {
        credentials: { inference: 'TEST_HF_READ' },
        hfApiURL: api,
        spaces: [{
          id: 'your-user/configured',
          label: 'Configured LLM',
          baseURL: 'http://127.0.0.1:9/v1',
          models: [{ id: 'open-model-q6', name: 'Open Model 27B', contextWindow: 131072, maxTokens: 32768, reasoning: { xhigh: 'xhigh', off: 'none', medium: 'medium', low: 'low' } }],
        }],
      });
      await fiber;
      await waitForRoute(ctx, 'configured-llm');
      const models = await ctx.llm.listModels('configured-llm');
      assert.deepEqual(models.map(m => [m.id, m.name]), [['open-model-q6', 'Open Model 27B']]);
      const info = await ctx.llm.resolveModelInfo('configured-llm', 'open-model-q6');
      assert.equal(info.name, 'Open Model 27B');
      assert.deepEqual(info.reasoning.efforts.map(e => e.id), ['off', 'low', 'medium', 'xhigh']);
      assert.equal(info.reasoning.defaultEffort, 'medium');
      assert.equal(info.context.contextWindow, 131072);
      // Everything was configured, so only the supervisor's state read (GET /runtime) reaches Hugging Face.
      const reads = seen.slice(readsBefore).map(r => r.url);
      assert.ok(reads.every(url => url === '/api/spaces/your-user/configured/runtime'), reads.join(', '));
    } finally {
      dispose();
    }
  });

  test('ready to use: with the Space id only, address and models come from Hugging Face and the manifest', async () => {
    const { ctx, dispose } = await environment();
    try {
      await ctx.plugin(asPlugin(plugin), {
        credentials: { inference: 'TEST_HF_READ' },
        hfApiURL: api,
        spaces: [{ id: 'your-user/with-manifest', label: 'From Manifest' }, { id: 'your-user/no-manifest', label: 'Nothing Listed' }],
      });
      await waitForRoute(ctx, 'from-manifest');
      const info = await ctx.llm.resolveModelInfo('from-manifest', 'open-model-q6');
      assert.equal(info.name, 'Open Model 27B');
      assert.deepEqual(info.reasoning.efforts.map(e => e.id), ['off', 'low', 'medium', 'xhigh']);
      assert.ok(seen.some(r => r.url.endsWith('/resolve/rev1/dsh-hf-spaces.json') && r.auth === 'Bearer test-token'));
      assert.ok(!routeIds(ctx).includes('nothing-listed'), 'a Space with no model listed is not offered');
    } finally {
      dispose();
    }
  });

  test('a route already served by another provider is refused alone; the other Spaces still register', async () => {
    const { ctx, dispose } = await environment();
    try {
      const spaceWith = (route, label) => ({ id: `your-user/${route}`, label, route, baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'm', name: label }] });
      await ctx.plugin(asPlugin(plugin), { credentials: { inference: 'TEST_HF_READ' }, spaces: [spaceWith('shared-route', 'First Owner')] });
      await waitForRoute(ctx, 'shared-route');
      await ctx.plugin(asPlugin(plugin), {
        credentials: { inference: 'TEST_HF_READ' },
        spaces: [spaceWith('shared-route', 'Second Owner'), spaceWith('free-route', 'Free Route')],
      });
      await waitForRoute(ctx, 'free-route');
      assert.equal(routeIds(ctx).filter(id => id === 'shared-route').length, 1);
      const [model] = await ctx.llm.listModels('shared-route');
      assert.equal(model.name, 'First Owner', 'the first owner keeps its route');
    } finally {
      dispose();
    }
  });

  test('disposing the plugin removes its routes', async () => {
    const { ctx, dispose } = await environment();
    try {
      const fiber = ctx.plugin(asPlugin(plugin), {
        credentials: { inference: 'TEST_HF_READ' },
        spaces: [{ id: 'your-user/configured', label: 'Gone Soon', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'm', name: 'M' }] }],
      });
      await fiber;
      await waitForRoute(ctx, 'gone-soon');
      fiber.dispose();
      await waitForRoute(ctx, 'gone-soon', false);
    } finally {
      dispose();
    }
  });
}
