import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { effectiveSpace, parseManifest } from '../src/manifest.mjs';
import { COMPAT, buildProviders, describeSpace } from '../src/route.mjs';

const settings = normalizeConfig({
  credentials: { inference: 'MY_HF_READ' },
  spaces: [{ id: 'your-user/your-llm-space', label: 'My LLM' }],
});
const manifest = parseManifest(JSON.stringify({
  schemaVersion: 1,
  models: [
    { id: 'open-model-q6', name: 'Open Model 27B', contextWindow: 262144, maxTokens: 32768, reasoning: { xhigh: 'xhigh', off: 'none', medium: 'medium', low: 'low' } },
    { id: 'plain-model', name: 'Plain Model 7B' },
  ],
})).manifest;
const space = effectiveSpace(settings.spaces[0], { host: 'https://your-user-your-llm-space.hf.space' }, manifest).space;

test('one provider route per Space, named by its label, credential by name', () => {
  const { providers } = buildProviders([space], settings.credentials);
  const route = providers['my-llm'];
  assert.equal(route.displayName, 'My LLM');
  assert.equal(route.api, 'openai-completions');
  assert.equal(route.baseURL, 'https://your-user-your-llm-space.hf.space/v1');
  assert.equal(route.apiKeyEnv, 'MY_HF_READ');
  assert.deepEqual(route.compat, { ...COMPAT, supportsReasoningEffort: true });
});

test('models keep the open name, sizes and the ordered effort levels; no levels means false', () => {
  const [first, second] = buildProviders([space], settings.credentials).providers['my-llm'].models;
  assert.deepEqual(first, {
    id: 'open-model-q6',
    name: 'Open Model 27B',
    contextWindow: 262144,
    maxTokens: 32768,
    reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
  });
  assert.deepEqual(Object.keys(first.reasoningEfforts), ['off', 'low', 'medium', 'xhigh']);
  assert.deepEqual(second, { id: 'plain-model', name: 'Plain Model 7B', reasoningEfforts: false });
});

test('a model that declares image input reaches the Harness with it; others stay text only', () => {
  const vision = effectiveSpace(settings.spaces[0], { host: 'https://x.hf.space' },
    { models: [{ id: 'open-model-q6', name: 'Open Model 27B', input: ['text', 'image'] }, { id: 'plain-model', name: 'Plain Model 7B' }] }).space;
  const [first, second] = buildProviders([vision], settings.credentials).providers['my-llm'].models;
  assert.deepEqual(first.input, ['text', 'image']);
  assert.equal('input' in second, false);
  assert.match(describeSpace(vision), /Open Model 27B \[reads images\], Plain Model 7B\)/);
});

test('the route default effort is set only when every model can use it', () => {
  const mixed = buildProviders([space], settings.credentials).providers['my-llm'];
  assert.equal(mixed.reasoning, undefined);
  const single = effectiveSpace(settings.spaces[0], { host: 'https://x.hf.space' }, { models: [manifest.models[0]] }).space;
  assert.equal(buildProviders([single], settings.credentials).providers['my-llm'].reasoning, 'medium');
});

test('the log line says where each value came from', () => {
  assert.equal(
    describeSpace(space),
    'your-user/your-llm-space: route my-llm; address from api; 2 models from manifest (Open Model 27B, Plain Model 7B); no default effort',
  );
});
