import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeText, identEmail, main, mask, messageBody, parseDenylist, scanText } from '../scripts/check-secrets.mjs';

// Fake tokens are built at runtime, so this file never contains a token-shaped literal.
const fake = (prefix, length) => prefix + 'x1Y2'.repeat(Math.ceil(length / 4)).slice(0, length);
const kinds = text => scanText(text).map(f => f.kind);

test('finds token formats and masks them', () => {
  const text = [
    `token: ${fake('hf_', 34)}`,
    `key = "${fake('sk-ant-', 40)}"`,
    `stripe ${fake('sk_' + 'live_', 24)}`,
    `gh: ${fake('ghp_', 36)}`,
    `google ${fake('AI' + 'za', 35)}`,
    `bot ${'123456789'}:${fake('AA', 33)}`,
    `jwt ${fake('ey' + 'J', 12)}.${fake('ey' + 'J', 12)}.${fake('', 12)}`,
    `//registry.npmjs.org/:_auth${'Token'}=${fake('', 20)}`,
    `authorization: bearer ${fake('', 40)}`,
    ['-----BEGIN', 'OPENSSH PRIVATE', 'KEY-----'].join(' '),
    `pass${'word'}: "${fake('', 20)}"`,
  ].join('\n');
  const findings = scanText(text);
  assert.deepEqual(findings.map(f => f.kind), [
    'Hugging Face token', 'OpenAI or Anthropic style key', 'Stripe key', 'GitHub token', 'Google API key',
    'Telegram bot token', 'JSON Web Token', 'npm auth token setting', 'bearer token', 'private key block', 'secret assignment',
  ]);
  for (const f of findings) assert.ok(!f.match.includes('x1Y2x1Y2'), `not masked: ${f.match}`);
});

test('ignores ordinary words, placeholders and variable references', () => {
  assert.deepEqual(kinds('a task-based and desk-compatible mask-image hf_short sk-short'), []);
  assert.deepEqual(kinds('apiKeyEnv: HF_TOKEN\ncredentials.inference: HF_TOKEN'), []);
  assert.deepEqual(kinds('//registry.npmjs.org/:_authToken=${NPM_TOKEN}'), []);
  assert.deepEqual(kinds('api_key: <your key here>\npassword = your-password-goes-here'), []);
});

test('finds local user paths but not shared folders, placeholders or URLs', () => {
  const real = ['C:\\Users\\' + 'alice\\project', '/Users/' + 'bob/code', 'file:///Users/' + 'dan/x', '/home/' + 'carol/x'].join('\n');
  assert.deepEqual(kinds(real), ['Windows user path', 'macOS user path', 'macOS user path', 'Linux home path']);
  assert.deepEqual(kinds([
    'C:\\Users\\<name>\\x', 'C:\\Users\\Public\\Documents', 'C:\\Users\\Default', 'C:\\Users\\username\\x',
    '/Users/<name>/x', '/Users/Shared/x', '/home/runner/work', '~/.dsh',
    'https://example.com/home/docs', 'https://example.com/Users/guide',
  ].join('\n')), []);
});

test('denylist terms are matched case-insensitively and reported masked', () => {
  const denylist = parseDenylist('# my terms\n\n  someone-private-space  \nMy-Bucket\n');
  assert.deepEqual(denylist, ['someone-private-space', 'My-Bucket']);
  const findings = scanText('space: Someone-Private-Space\nbucket: my-bucket', denylist);
  assert.deepEqual(findings.map(f => [f.line, f.kind]), [[1, 'private denylist term'], [2, 'private denylist term']]);
  assert.ok(findings.every(f => !f.match.includes('private-space')));
});

test('decodes UTF-8 and UTF-16 (with or without BOM) and refuses binary', () => {
  const token = fake('hf_', 34);
  assert.equal(decodeText(Buffer.from(token, 'utf8')), token);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(token, 'utf16le')])), token);
  assert.equal(decodeText(Buffer.from(token, 'utf16le')), token);
  const be = Buffer.from(token, 'utf16le').swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), token);
  assert.equal(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0])), undefined);
});

test('mask, messageBody and identEmail', () => {
  assert.equal(mask('abcdefghijklmnop'), 'abcdef…(16 chars)');
  assert.equal(mask('abc'), 'ab…');
  assert.equal(messageBody('subject\n# Please enter the commit message\nbody'), 'subject\nbody');
  assert.equal(identEmail('Someone <someone@example.com> 1700000000 +0000'), 'someone@example.com');
});

/** Fake git and files for main(): `files` is the tracked/staged set, `blobs` the content, `idents` the identities. */
function harness({ files = {}, denylist, envDenylist, idents = {}, message, gitFails = false } = {}) {
  const out = [];
  const err = [];
  const gitCalls = [];
  const fsFiles = new Map();
  if (denylist !== undefined) fsFiles.set('/repo/.private-denylist', Buffer.from(denylist));
  if (message !== undefined) fsFiles.set('/tmp/MSG', Buffer.from(message));
  for (const [name, content] of Object.entries(files)) fsFiles.set(`/repo/${name}`, Buffer.isBuffer(content) ? content : Buffer.from(content));
  const io = {
    env: envDenylist ? { DSH_PRIVATE_DENYLIST: envDenylist } : {},
    exists: file => fsFiles.has(file.replaceAll('\\', '/')),
    readFile: (file) => {
      const content = fsFiles.get(file.replaceAll('\\', '/'));
      if (!content) throw new Error(`ENOENT ${file}`);
      return content;
    },
    git: (args, options = {}) => {
      if (gitFails) throw new Error('not a git repository');
      gitCalls.push(args.join(' '));
      const [cmd] = args;
      if (cmd === 'rev-parse') return '/repo\n';
      if (cmd === 'ls-files' || cmd === 'diff') return Object.keys(files).join('\0') + '\0';
      if (cmd === 'show') {
        const content = fsFiles.get(`/repo/${args[1].slice(1)}`);
        return options.buffer ? content : content.toString('utf8');
      }
      if (cmd === 'var') {
        if (!(args[1] in idents)) throw new Error('no ident');
        return idents[args[1]];
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    out: line => out.push(line),
    err: line => err.push(line),
  };
  return { io, out, err, gitCalls };
}

const NOREPLY = { GIT_AUTHOR_IDENT: 'x <1+x@users.noreply.github.com> 1 +0000', GIT_COMMITTER_IDENT: 'x <1+x@users.noreply.github.com> 1 +0000' };

test('cli: staged mode reads blobs, scans the identity, exits 1 on findings and 0 when clean', () => {
  const dirty = harness({ files: { 'a.md': `t ${fake('hf_', 34)}`, 'b.ps1': Buffer.from(`k ${fake('hf_', 34)}`, 'utf16le') }, denylist: '# none\n', idents: NOREPLY });
  assert.equal(main(['--staged'], dirty.io), 1);
  assert.equal(dirty.err.filter(l => /Hugging Face token/.test(l)).length, 2); // the UTF-16 file is scanned too
  const clean = harness({ files: { 'a.md': 'nothing here' }, denylist: '# none\n', idents: NOREPLY });
  assert.equal(main(['--staged'], clean.io), 0);
  assert.match(clean.out[0], /^ok: 1 file\(s\) \(staged\) and commit identity scanned/);
});

test('cli: commit modes fail closed without a denylist; the tracked-files mode only notes it', () => {
  const staged = harness({ files: { 'a.md': 'ok' }, idents: NOREPLY });
  assert.equal(main(['--staged'], staged.io), 2);
  assert.match(staged.err[0], /no \.private-denylist/);
  const message = harness({ message: 'fix: typo' });
  assert.equal(main(['--message', '/tmp/MSG'], message.io), 2);
  const tracked = harness({ files: { 'a.md': 'ok' } });
  assert.equal(main([], tracked.io), 0);
  assert.match(tracked.err[0], /^note: no \.private-denylist/);
  // new files are scanned before anyone stages them; git-ignored ones are not
  assert.ok(tracked.gitCalls.includes('ls-files -z --cached --others --exclude-standard'));
});

test('cli: DSH_PRIVATE_DENYLIST naming a missing file is an error, not a silent skip', () => {
  const run = harness({ files: { 'a.md': 'ok' }, envDenylist: '/nowhere/denylist', idents: NOREPLY });
  assert.equal(main([], run.io), 2);
  assert.match(run.err[0], /DSH_PRIVATE_DENYLIST points to a missing file/);
});

test('cli: personal data in the commit identity or message is refused; a personal e-mail warns', () => {
  const ident = harness({ files: { 'a.md': 'ok' }, denylist: 'private-domain.example\n',
    idents: { GIT_AUTHOR_IDENT: 'me <me@private-domain.example> 1 +0000', GIT_COMMITTER_IDENT: NOREPLY.GIT_COMMITTER_IDENT } });
  assert.equal(main(['--staged'], ident.io), 1);
  assert.ok(ident.err.some(l => /^GIT_AUTHOR_IDENT:1: private denylist term/.test(l)));
  assert.ok(ident.err.some(l => /^warning: GIT_AUTHOR_IDENT uses/.test(l)));
  const message = harness({ denylist: '# none\n', message: `fix: rotate ${fake('hf_', 34)}\n# comment ${fake('ghp_', 36)}` });
  assert.equal(main(['--message', '/tmp/MSG'], message.io), 1);
  assert.equal(message.err.filter(l => /^commit message:/.test(l)).length, 1); // comment lines are ignored
});

test('cli: outside a git repository it stops with a setup error', () => {
  const run = harness({ gitFails: true });
  assert.equal(main([], run.io), 2);
  assert.match(run.err[0], /not inside a git repository/);
});
