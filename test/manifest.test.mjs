import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { defaultEffortFor, effectiveSpace, parseManifest } from '../src/manifest.mjs';

const QWEN = { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' };
const manifestText = (extra = {}) => JSON.stringify({
  schemaVersion: 1,
  models: [{ id: 'open-model-q6', name: 'Open Model 27B', contextWindow: 262144, maxTokens: 32768, reasoning: QWEN }],
  progress: { eventPrefix: 'SPACE_EVENT' },
  idleSeconds: 3600,
  ...extra,
});
const configured = (extra = {}) => normalizeConfig({ spaces: [{ id: 'your-user/your-llm-space', label: 'My LLM', ...extra }] }).spaces[0];
const API = { host: 'https://your-user-your-llm-space.hf.space', sha: 'abc123', gcTimeout: 3600 };

test('manifest: a valid one is read whole', () => {
  const { manifest } = parseManifest(manifestText());
  assert.equal(manifest.models[0].name, 'Open Model 27B');
  assert.deepEqual(Object.keys(manifest.models[0].reasoning), ['off', 'low', 'medium', 'xhigh']);
  assert.equal(manifest.eventPrefix, 'SPACE_EVENT');
  assert.equal(manifest.idleSeconds, 3600);
});

test('manifest: an invalid one is refused as a whole, with the reason', () => {
  assert.match(parseManifest('{').problem, /not valid JSON/);
  assert.match(parseManifest('[]').problem, /JSON object/);
  assert.match(parseManifest(manifestText({ schemaVersion: 2 })).problem, /schemaVersion must be 1/);
  assert.match(parseManifest(manifestText({ models: [] })).problem, /lists no model/);
  assert.match(parseManifest(manifestText({ models: [{ id: 'm', reasoning: { turbo: 'x' } }] })).problem, /unknown reasoning level/);
  assert.match(parseManifest(manifestText({ idleSeconds: -1 })).problem, /idleSeconds/);
});

test('ready to use: Space id only, everything else from the API and the manifest', () => {
  const { space } = effectiveSpace(configured(), API, parseManifest(manifestText()).manifest);
  assert.deepEqual(space.baseURL, { value: 'https://your-user-your-llm-space.hf.space/v1', source: 'api' });
  assert.equal(space.models.source, 'manifest');
  assert.deepEqual(space.defaultEffort, { value: 'medium', source: 'default' });
  assert.deepEqual(space.eventPrefix, { value: 'SPACE_EVENT', source: 'manifest' });
  assert.deepEqual(space.idleSeconds, { value: 3600, source: 'manifest' });
  assert.equal(space.sha, 'abc123');
});

test('the configuration wins over the manifest, and the manifest over the API', () => {
  const space = effectiveSpace(
    configured({ baseURL: 'https://other.hf.space/v1', models: [{ id: 'mine', name: 'Mine' }], progress: { eventPrefix: 'MY_EVENT' } }),
    API,
    parseManifest(manifestText()).manifest,
  ).space;
  assert.deepEqual(space.baseURL, { value: 'https://other.hf.space/v1', source: 'config' });
  assert.deepEqual(space.models, { value: [{ id: 'mine', name: 'Mine' }], source: 'config' });
  assert.deepEqual(space.eventPrefix, { value: 'MY_EVENT', source: 'config' });
  assert.equal(space.defaultEffort, undefined); // the configured model has no reasoning levels
  const noManifestIdle = effectiveSpace(configured({ models: [{ id: 'm' }] }), API, undefined).space;
  assert.deepEqual(noManifestIdle.idleSeconds, { value: 3600, source: 'api' });
  assert.deepEqual(noManifestIdle.eventPrefix, { value: 'SPACE_EVENT', source: 'default' });
});

test('start variables: from the manifest unless the configuration declares its own', () => {
  const declared = { SPACE_SESSION: { id: '{{uuid}}' } };
  const manifest = parseManifest(manifestText({ startVariables: declared })).manifest;
  assert.deepEqual(manifest.startVariables, declared);
  assert.deepEqual(effectiveSpace(configured(), API, manifest).space.startVariables, declared);
  const own = { MY_START: 'x' };
  assert.deepEqual(effectiveSpace(configured({ start: { variables: own } }), API, manifest).space.startVariables, own);
  assert.equal('startVariables' in effectiveSpace(configured(), API, parseManifest(manifestText()).manifest).space, false);
  assert.match(parseManifest(manifestText({ startVariables: { 'BAD NAME': 1 } })).problem, /startVariables: "BAD NAME" is not a variable name/);
});

test('no guessing: a missing address or model list is refused with the fix', () => {
  assert.match(effectiveSpace(configured(), undefined, undefined).problem, /address is unknown.*set `baseURL`/);
  assert.match(effectiveSpace(configured(), API, undefined).problem, /no model listed; add `models`.*dsh-hf-spaces\.json/);
});

test('default effort: configured, else medium when every model lists it, else none', () => {
  const both = [{ id: 'a', reasoning: QWEN }, { id: 'b', reasoning: { off: 'none', low: 'low' } }];
  assert.equal(defaultEffortFor(both, undefined), undefined);
  assert.deepEqual(defaultEffortFor(both, 'low'), { value: 'low', source: 'config' });
  assert.equal(defaultEffortFor(both, 'xhigh'), undefined);
  assert.equal(defaultEffortFor([{ id: 'a' }], undefined), undefined);
  assert.match(effectiveSpace(configured({ defaultEffort: 'high', models: [{ id: 'a', reasoning: QWEN }] }), API).problem, /defaultEffort "high" is not listed/);
});
