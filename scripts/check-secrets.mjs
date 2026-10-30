#!/usr/bin/env node
/**
 * Secret and personal-data scanner for this public repository. No dependencies.
 *
 * Usage:
 *   node scripts/check-secrets.mjs                  scan every tracked file (CI, `npm run check`)
 *   node scripts/check-secrets.mjs --staged         scan staged content and the commit identity (pre-commit hook)
 *   node scripts/check-secrets.mjs --message FILE   scan a commit message (commit-msg hook)
 *
 * Personal terms (account names, Space ids, home folders, e-mail domains...) come from
 * `.private-denylist` (git-ignored, one literal per line, `#` starts a comment) or from the file
 * named by DSH_PRIVATE_DENYLIST. They are matched case-insensitively and printed masked.
 *
 * The commit modes (--staged, --message) fail closed: they refuse to run without a denylist,
 * because a missing denylist would silently let personal data through. A denylist with only
 * comments is an explicit "nothing personal to check". The tracked-files mode only notes it,
 * since CI never has a denylist.
 *
 * Exit codes: 0 clean, 1 findings, 2 setup problem (missing denylist, not a git repository).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Token formats, by provider. Matches are reported masked. Rules use `i` only where the format is case-insensitive. */
export const SECRET_PATTERNS = Object.freeze([
  { name: 'Hugging Face token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'OpenAI or Anthropic style key', regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Stripe key', regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'npm auth token setting', regex: /_auth(?:Token)?\s*=\s*(?!\$\{)[^\s#'"]{8,}/g },
  { name: 'NVIDIA Brev API key', regex: /\bbak-[A-Za-z0-9_-]{24,}\b/g },
  { name: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Telegram bot token', regex: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g },
  { name: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{30,}/gi },
  {
    name: 'secret assignment',
    regex: /\b(?:password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?(?!\$\{|<|your|example|xxx|changeme)[A-Za-z0-9/+_.=~-]{16,}/gi,
  },
]);

// Folder names that never identify a person, and placeholders used in documentation.
const NOT_PERSONAL = '(?!<|your|you\\b|name\\b|user\\b|username\\b|Public\\b|Default\\b|All Users\\b|Shared\\b|runner\\b)';

/**
 * Paths that reveal a local user name. The negative lookbehind keeps URL paths out:
 * `https://site/home/docs` is preceded by a word character, while `file:///Users/<name>` is
 * preceded by a slash and still matches.
 */
export const PATH_PATTERNS = Object.freeze([
  { name: 'Windows user path', regex: new RegExp(`(?<![\\w.-])[A-Za-z]:[\\\\/]+Users[\\\\/]+${NOT_PERSONAL}[^\\\\/\\s'"\`<>]+`, 'gi') },
  { name: 'macOS user path', regex: new RegExp(`(?<![\\w.-])/Users/${NOT_PERSONAL}[A-Za-z0-9._-]+`, 'g') },
  { name: 'Linux home path', regex: new RegExp(`(?<![\\w.-])/home/${NOT_PERSONAL}[A-Za-z0-9._-]+`, 'g') },
]);

/** First characters of a match, enough to locate it without repeating the secret. */
export function mask(text) {
  return text.length <= 8 ? `${text.slice(0, 2)}…` : `${text.slice(0, 6)}…(${text.length} chars)`;
}

/** Literals from a denylist file body: trimmed, without blanks and `#` comments. */
export function parseDenylist(body) {
  return String(body ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

/**
 * Text of a file: UTF-8, or UTF-16 (with BOM, or detected by NUL bytes on one byte parity, which
 * Windows PowerShell 5.1 and `cmd >` produce). Returns undefined for binary content.
 * @param {Buffer} buffer
 */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return swap16(buffer.subarray(2)).toString('utf16le');
  if (!buffer.includes(0)) return buffer.toString('utf8');
  const sample = buffer.subarray(0, 8192);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < sample.length; i += 1) if (sample[i] === 0) (i % 2 ? odd += 1 : even += 1);
  const half = sample.length / 2;
  if (odd > half * 0.3 && even < half * 0.05) return buffer.toString('utf16le');
  if (even > half * 0.3 && odd < half * 0.05) return swap16(buffer).toString('utf16le');
  return undefined;
}

function swap16(buffer) {
  const copy = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)));
  return copy.swap16();
}

/**
 * Findings in one text: [{ line, kind, match }], `match` already masked.
 * @param {string} text
 * @param {string[]} denylist literal personal terms, matched case-insensitively
 */
export function scanText(text, denylist = []) {
  const findings = [];
  const terms = denylist.map(term => term.toLowerCase());
  String(text).split(/\r?\n/).forEach((content, index) => {
    for (const { name, regex } of SECRET_PATTERNS) {
      for (const m of content.matchAll(regex)) findings.push({ line: index + 1, kind: name, match: mask(m[0]) });
    }
    for (const { name, regex } of PATH_PATTERNS) {
      for (const m of content.matchAll(regex)) findings.push({ line: index + 1, kind: name, match: mask(m[0]) });
    }
    const lower = content.toLowerCase();
    terms.forEach((term, i) => {
      if (lower.includes(term)) findings.push({ line: index + 1, kind: 'private denylist term', match: mask(denylist[i]) });
    });
  });
  return findings;
}

/** Commit message without the `#` comment lines git adds to the editor template. */
export function messageBody(text) {
  return String(text).split(/\r?\n/).filter(line => !line.startsWith('#')).join('\n');
}

/** E-mail of a `git var GIT_AUTHOR_IDENT` line ("Name <email> 1700000000 +0000"). */
export function identEmail(ident) {
  return /<([^>]*)>/.exec(String(ident))?.[1];
}

const defaultIo = {
  git: (args, { buffer = false } = {}) => execFileSync('git', args, { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
  readFile: file => fs.readFileSync(file),
  exists: file => fs.existsSync(file),
  env: process.env,
  out: message => console.log(message),
  err: message => console.error(message),
};

/** `{ terms, source }`, or `{ problem }` when DSH_PRIVATE_DENYLIST names a missing file, or `{ terms: undefined }` when there is none. */
function readDenylist(root, io) {
  const fromEnv = io.env.DSH_PRIVATE_DENYLIST;
  if (fromEnv && !io.exists(fromEnv)) return { problem: `DSH_PRIVATE_DENYLIST points to a missing file: ${fromEnv}` };
  const file = fromEnv || path.join(root, '.private-denylist');
  return io.exists(file) ? { terms: parseDenylist(io.readFile(file).toString('utf8')), source: file } : { terms: undefined };
}

/**
 * Runs the scanner. Every side effect goes through `io`, so tests can drive it without git or files.
 * @returns {number} exit code
 */
export function main(argv, io = defaultIo) {
  const staged = argv.includes('--staged');
  const messageAt = argv.indexOf('--message');
  const messageFile = messageAt >= 0 ? argv[messageAt + 1] : undefined;
  if (messageAt >= 0 && !messageFile) { io.err('usage: check-secrets.mjs --message <file>'); return 2; }
  const commitMode = staged || messageFile !== undefined;

  let root;
  try {
    root = io.git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    io.err('error: not inside a git repository');
    return 2;
  }
  const denylist = readDenylist(root, io);
  if (denylist.problem) { io.err(`error: ${denylist.problem}`); return 2; }
  if (denylist.terms === undefined) {
    if (commitMode) {
      io.err('error: no .private-denylist. Create it (git-ignored) with your personal terms, one per line; a file with only comments means "nothing personal to check". See AGENTS.md, section 4.');
      return 2;
    }
    io.err('note: no .private-denylist found; personal terms were not checked (see AGENTS.md, section 4)');
  }
  const terms = denylist.terms ?? [];

  const report = [];
  const add = (where, findings) => findings.forEach(f => report.push(`${where}:${f.line}: ${f.kind}: ${f.match}`));
  let scanned = 0;

  if (messageFile !== undefined) {
    add('commit message', scanText(messageBody(decodeText(io.readFile(messageFile)) ?? ''), terms));
    scanned = 1;
  } else {
    const files = (staged
      ? io.git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'])
      : io.git(['ls-files', '-z'])).split('\0').filter(Boolean);
    for (const file of files) {
      let buffer;
      try {
        buffer = staged ? io.git(['show', `:${file}`], { buffer: true }) : io.readFile(path.join(root, file));
      } catch {
        continue; // deleted in the working tree, or a submodule entry
      }
      scanned += 1;
      const text = decodeText(buffer);
      if (text !== undefined) add(file, scanText(text, terms));
    }
    if (staged) {
      for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
        let ident = '';
        try { ident = io.git(['var', variable]); } catch { continue; }
        add(variable, scanText(ident, terms));
        const email = identEmail(ident);
        if (email && !email.endsWith('@users.noreply.github.com')) {
          io.err(`warning: ${variable} uses ${mask(email)}; it becomes public in history. Consider your GitHub noreply address (see AGENTS.md, section 4).`);
        }
      }
    }
  }

  if (report.length) {
    report.forEach(line => io.err(line));
    io.err(`\n${report.length} finding(s). Remove them before committing; if a real token leaked, revoke it now.`);
    return 1;
  }
  io.out(`ok: ${messageFile !== undefined ? 'commit message' : `${scanned} file(s)${staged ? ' (staged) and commit identity' : ''}`} scanned, no secrets or personal data found`);
  return 0;
}

/** True when this file is the program being run, also through a symlink or a different path casing. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
