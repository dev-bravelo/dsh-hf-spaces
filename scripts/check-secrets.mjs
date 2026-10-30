#!/usr/bin/env node
/**
 * Secret and personal-data scanner for this public repository. No dependencies.
 *
 * Usage:
 *   node scripts/check-secrets.mjs            scan every tracked file
 *   node scripts/check-secrets.mjs --staged   scan only staged content (pre-commit hook)
 *
 * Personal terms (account names, Space ids, home paths...) are read from `.private-denylist`
 * (git-ignored, one literal per line, `#` starts a comment) or from the file named by the
 * DSH_PRIVATE_DENYLIST environment variable. They are matched case-insensitively and never
 * printed back in full. Exit code 1 when anything is found.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Token formats, by provider. Matches are reported masked. */
export const SECRET_PATTERNS = Object.freeze([
  { name: 'Hugging Face token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'OpenAI or Anthropic style key', regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'NVIDIA Brev API key', regex: /\bbak-[A-Za-z0-9_-]{24,}\b/g },
  { name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Slack token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{30,}/g },
]);

/** Paths that reveal a local user name. */
export const PATH_PATTERNS = Object.freeze([
  { name: 'Windows user path', regex: /\b[A-Za-z]:[\\/]+Users[\\/]+(?!<|your|you\b|name\b|user\b)[^\\/\s'"`<>]+/gi },
  { name: 'macOS user path', regex: /\/Users\/(?!<|your|you\b|name\b|user\b|Shared\b)[A-Za-z0-9._-]+/g },
  { name: 'Linux home path', regex: /\/home\/(?!<|your|you\b|name\b|user\b|runner\b)[A-Za-z0-9._-]+/g },
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
 * Findings in one text: [{ line, kind, match }], `match` already masked.
 * @param {string} text
 * @param {string[]} denylist literal personal terms, matched case-insensitively
 */
export function scanText(text, denylist = []) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((content, index) => {
    for (const { name, regex } of [...SECRET_PATTERNS, ...PATH_PATTERNS]) {
      for (const m of content.matchAll(regex)) findings.push({ line: index + 1, kind: name, match: mask(m[0]) });
    }
    const lower = content.toLowerCase();
    for (const term of denylist) {
      if (lower.includes(term.toLowerCase())) findings.push({ line: index + 1, kind: 'private denylist term', match: mask(term) });
    }
  });
  return findings;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readDenylist(root) {
  const file = process.env.DSH_PRIVATE_DENYLIST || path.join(root, '.private-denylist');
  return fs.existsSync(file) ? parseDenylist(fs.readFileSync(file, 'utf8')) : [];
}

function main(argv) {
  const staged = argv.includes('--staged');
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const denylist = readDenylist(root);
  const files = (staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    : git(['ls-files', '-z'])).split('\0').filter(Boolean);
  let total = 0;
  for (const file of files) {
    let text;
    try {
      text = staged ? git(['show', `:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue; // deleted or unreadable
    }
    if (text.includes('\0')) continue; // binary
    for (const f of scanText(text, denylist)) {
      console.error(`${file}:${f.line}: ${f.kind}: ${f.match}`);
      total += 1;
    }
  }
  if (!denylist.length) console.error('note: no .private-denylist found; personal terms were not checked (see AGENTS.md, section 4)');
  if (total) {
    console.error(`\n${total} finding(s). Remove them before committing; if a real token leaked, revoke it now.`);
    return 1;
  }
  console.log(`ok: ${files.length} file(s) scanned${staged ? ' (staged)' : ''}, no secrets or personal data found`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
