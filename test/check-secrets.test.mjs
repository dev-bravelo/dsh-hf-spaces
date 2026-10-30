import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mask, parseDenylist, scanText } from '../scripts/check-secrets.mjs';

// Fake tokens are built at runtime, so this file never contains a token-shaped literal.
const fake = (prefix, length) => prefix + 'x1Y2'.repeat(Math.ceil(length / 4)).slice(0, length);

test('finds token formats and masks them', () => {
  const text = [
    `token: ${fake('hf_', 34)}`,
    `key = "${fake('sk-ant-', 40)}"`,
    `gh: ${fake('ghp_', 36)}`,
    `Authorization: Bearer ${fake('', 40)}`,
    ['-----BEGIN', 'OPENSSH PRIVATE', 'KEY-----'].join(' '),
  ].join('\n');
  const findings = scanText(text);
  assert.deepEqual(findings.map(f => f.kind), [
    'Hugging Face token', 'OpenAI or Anthropic style key', 'GitHub token', 'bearer token', 'private key block',
  ]);
  for (const f of findings) assert.ok(!f.match.includes('x1Y2x1Y2'), `not masked: ${f.match}`);
});

test('ignores ordinary words that look like prefixes', () => {
  assert.deepEqual(scanText('a task-based and desk-compatible mask-image hf_short sk-short'), []);
});

test('finds local user paths but not documentation placeholders', () => {
  const real = ['C:\\Users\\' + 'alice\\project', '/Users/' + 'bob/code', '/home/' + 'carol/x'].join('\n');
  assert.deepEqual(scanText(real).map(f => f.kind), ['Windows user path', 'macOS user path', 'Linux home path']);
  assert.deepEqual(scanText('C:\\Users\\<name>\\x and /Users/<name>/x and /home/runner/work and ~/.dsh'), []);
});

test('denylist terms are matched case-insensitively and reported masked', () => {
  const denylist = parseDenylist('# my terms\n\n  someone-private-space  \nMy-Bucket\n');
  assert.deepEqual(denylist, ['someone-private-space', 'My-Bucket']);
  const findings = scanText('space: Someone-Private-Space\nbucket: my-bucket', denylist);
  assert.deepEqual(findings.map(f => [f.line, f.kind]), [[1, 'private denylist term'], [2, 'private denylist term']]);
  assert.ok(findings.every(f => !f.match.includes('private-space')));
});

test('mask keeps only a short prefix', () => {
  assert.equal(mask('abcdefghijklmnop'), 'abcdef…(16 chars)');
  assert.equal(mask('abc'), 'ab…');
});
