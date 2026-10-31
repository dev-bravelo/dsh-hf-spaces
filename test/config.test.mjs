import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, HARNESS_LEVELS, checkBaseURL, isLoopbackURL, isSpaceURL, normalizeConfig, normalizeModel, normalizeReasoning, routeFromLabel } from '../src/config.mjs';

const space = (extra = {}) => ({ id: 'your-user/your-llm-space', ...extra });

test('an empty configuration registers nothing and has no problem', () => {
  const s = normalizeConfig({});
  assert.deepEqual(s.spaces, []);
  assert.deepEqual(s.problems, []);
  assert.deepEqual(s.credentials, { ...DEFAULTS.credentials });
});

test('only the Space id is required; label and route come from it', () => {
  const { spaces, problems } = normalizeConfig({ spaces: [space()] });
  assert.deepEqual(problems, []);
  assert.equal(spaces[0].label, 'your-llm-space');
  assert.equal(spaces[0].route, 'your-llm-space');
  assert.deepEqual(spaces[0].models, []);
});

test('route: derived from the label, explicit when given, refused when unusable or repeated', () => {
  assert.equal(routeFromLabel('My LLM (A100)'), 'my-llm-a100');
  assert.equal(routeFromLabel('Modelo Grátis Ação'), 'modelo-gratis-acao');
  assert.equal(routeFromLabel('!!!'), undefined);
  assert.equal(routeFromLabel('x'.repeat(33)), undefined);
  const { spaces, problems } = normalizeConfig({
    spaces: [
      space({ label: 'My LLM' }),
      space({ id: 'your-user/other', label: 'My LLM' }),
      space({ id: 'your-user/third', route: 'Bad_Route' }),
      space({ id: 'your-user/fourth', route: 'stable-id' }),
    ],
  });
  assert.deepEqual(spaces.map(s => s.route), ['my-llm', 'stable-id']);
  assert.match(problems[0], /your-user\/other: route "my-llm" is already used/);
  assert.match(problems[1], /your-user\/third: route "Bad_Route" is not usable/);
});

test('a bad Space is refused alone, with the fix in the message', () => {
  const { spaces, problems } = normalizeConfig({ spaces: [{ id: 'not-an-id' }, space()] });
  assert.equal(spaces.length, 1);
  assert.match(problems[0], /`id` must be the Space id, owner\/name/);
});

test('credentials are names, never values', () => {
  const { credentials, problems } = normalizeConfig({ credentials: { inference: 'MY_HF_READ', control: 'hf_abc def' } });
  assert.equal(credentials.inference, 'MY_HF_READ');
  assert.equal(credentials.control, DEFAULTS.credentials.control);
  assert.match(problems[0], /credentials\.control must be a credential name/);
  // A pasted Hugging Face token is a valid identifier too, so it is caught on its own.
  // Built at run time, so the secret scanner never sees a token-shaped literal here.
  const pasted = ['hf', '_', 'A1b2'.repeat(9)].join('');
  const caught = normalizeConfig({ credentials: { inference: pasted } });
  assert.equal(caught.credentials.inference, DEFAULTS.credentials.inference);
  assert.match(caught.problems[0], /not a token value; if a token was pasted here, remove it and revoke it/);
  assert.ok(!caught.problems[0].includes(pasted), 'the message never repeats the token');
  assert.equal(normalizeConfig({ credentials: { inference: 'HF_TOKEN_READ' } }).problems.length, 0);
});

test('baseURL: only a Space address, or this machine for tests (the token is sent there)', () => {
  assert.equal(checkBaseURL('https://x.hf.space/v1'), undefined);
  assert.equal(checkBaseURL('http://127.0.0.1:8080/v1'), undefined);
  assert.match(checkBaseURL('http://example.com/v1'), /Space address/);
  assert.match(checkBaseURL('https://proxy.example.com/v1'), /the inference token is sent there/);
  assert.match(checkBaseURL('https://x.hf.space.example.com/v1'), /Space address/);
  assert.match(checkBaseURL('https://user:pw@x.hf.space/v1'), /Space address/);
  assert.equal(isSpaceURL('https://your-user-your-llm-space.hf.space'), true);
  assert.equal(isSpaceURL('http://x.hf.space'), false);
  assert.equal(isLoopbackURL('http://localhost:1'), true);
  assert.equal(isLoopbackURL('http://localhost.example.com'), false);
  const { spaces } = normalizeConfig({ spaces: [space({ baseURL: 'https://x.hf.space/v1/' })] });
  assert.equal(spaces[0].baseURL, 'https://x.hf.space/v1');
});

test('reasoning: ordered from least to greatest, false allowed, unknown or empty refused', () => {
  assert.deepEqual(Object.keys(normalizeReasoning({ xhigh: 'xhigh', off: 'none', medium: 'medium', low: 'low' }).value), ['off', 'low', 'medium', 'xhigh']);
  assert.deepEqual(normalizeReasoning(false), { value: false });
  assert.deepEqual(normalizeReasoning(undefined), { value: undefined });
  assert.match(normalizeReasoning({ turbo: 'x' }).problem, /unknown reasoning level "turbo"/);
  assert.match(normalizeReasoning({}).problem, /empty/);
  assert.match(normalizeReasoning({ low: '' }).problem, /needs the value/);
  assert.deepEqual(HARNESS_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('model: name defaults to id, sizes must be positive whole numbers', () => {
  assert.deepEqual(normalizeModel({ id: 'm' }).model, { id: 'm', name: 'm' });
  assert.match(normalizeModel({ id: 'm', contextWindow: 0 }).problem, /contextWindow/);
  assert.match(normalizeModel({ name: 'x' }).problem, /needs `id`/);
  const { spaces, problems } = normalizeConfig({ spaces: [space({ models: [{ id: 'a' }, { id: 'a' }, { id: 'b', reasoning: { nope: 'x' } }] })] });
  assert.deepEqual(spaces[0].models.map(m => m.id), ['a']);
  assert.equal(problems.length, 2);
});

test('defaultEffort must be a Harness level', () => {
  const { spaces, problems } = normalizeConfig({ spaces: [space({ defaultEffort: 'turbo' })] });
  assert.equal(spaces.length, 0);
  assert.match(problems[0], /defaultEffort "turbo"/);
});
