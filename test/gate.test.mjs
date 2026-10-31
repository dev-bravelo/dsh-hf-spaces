import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAILURE_COOLDOWN_MS, fixedReply, formatDuration, inCooldown, pendingUserText, planRequest } from '../src/gate.mjs';
import { textsFor } from '../src/messages.mjs';

test('plan: trusted while recently seen serving, joins a start in progress, else checks', () => {
  assert.equal(planRequest({ now: 10, readyUntil: 20 }), 'proceed');
  assert.equal(planRequest({ now: 30, readyUntil: 20, phase: 'starting' }), 'starting');
  assert.equal(planRequest({ now: 30, readyUntil: 20 }), 'check');
  assert.equal(inCooldown({ now: 1000, lastFailureAt: undefined }), false);
  assert.equal(inCooldown({ now: FAILURE_COOLDOWN_MS - 1, lastFailureAt: 0 }), true);
  assert.equal(inCooldown({ now: FAILURE_COOLDOWN_MS, lastFailureAt: 0 }), false);
});

test('pending text: the last message the user typed, never a plugin notice', () => {
  const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const notice = { role: 'user', source: { kind: 'dsh-hf-spaces' }, content: [{ type: 'text', text: '[Automatic notice]' }] };
  assert.equal(pendingUserText([user('first'), { role: 'assistant', content: [] }, user('second'), notice]), 'second');
  assert.equal(pendingUserText([notice]), undefined);
  assert.equal(pendingUserText([user('x'.repeat(2000))]).length, 1501);
});

test('fixed reply: one visible text block and a normal end of turn', async () => {
  const chunks = [];
  for await (const chunk of fixedReply('hello')) chunks.push(chunk.type);
  assert.deepEqual(chunks, ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(125), '2 min 05 s');
});

test('texts: the start notice says where to look and that the session resumes; both locales', () => {
  for (const locale of ['en', 'pt-BR']) {
    const t = textsFor(locale);
    const starting = t.starting('My LLM', t.where('My LLM'));
    assert.match(starting, /dsh-hf-spaces/);
    assert.match(starting, /"background job"/);
    assert.match(t.ready('My LLM', 200, 'oi'), /«oi»\]$/);
    assert.match(t.failed('My LLM', 'x', false), /(may still bill|pode continuar cobrando)/);
  }
  assert.equal(textsFor('fr'), textsFor('en'));
});
