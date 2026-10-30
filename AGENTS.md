# Instructions for AI agents and contributors

This file is written for AI coding agents (Claude Code, Codex, DeepSeek Harness agents and
others) and for people. Read it completely before changing anything. When a rule here conflicts
with a habit or a default, the rule here wins.

## 1. What this repository is

`dsh-hf-spaces` is a plugin for **DeepSeek Harness**: Host and Client halves, in one npm
package. It lets the Harness use an LLM served from a GPU **Hugging Face Space**, starting
the Space on demand and stopping it when idle.

- **Status:** pre-alpha. Read [docs/design.md](docs/design.md) before writing code.
- **Public repository:** everything committed here may be read by anyone, forever, including
  through git history and forks.

## 2. Hard rules

### You MUST NOT

1. **Commit a secret:**
   - no tokens, API keys, passwords, cookies, private keys or `.env` files;
   - no file copied from a credential vault (for example `~/.dsh/.credentials.yaml` or
     `auth.json`).
2. **Commit personal or account data:**
   - real account names (other than the repository owner in URLs), real Space ids, bucket
     names, e-mail addresses;
   - local paths such as `C:\Users\<name>` or `/Users/<name>`;
   - session ids, billing amounts of a real account, screenshots of a real account.
3. **Hard-code a default Space, account, model or price** that belongs to a real user. Defaults
   must be empty or clearly fake (`your-user/your-llm-space`).
4. **Print, log or return a token value**, even partially. Refer to credentials by name only.
5. **Call real Hugging Face APIs or real Spaces from tests.** Tests run offline against
   simulators.
6. **Add a runtime dependency** without a concrete need stated in the pull request. The Host
   half uses Node.js built-ins and the packages the Harness provides.
7. **Modify a DeepSeek Harness installation** (`app.asar`, executables) or rely on its private
   internals when a public extension point exists.

### You MUST

1. **Write everything in English:** code, comments, docs, commit messages, issues.
2. **Run `npm run check` before every commit.** It scans for secrets and personal data and runs
   the tests. Install the pre-commit hook once with `npm run hooks`.
3. **Keep credentials as names:** configuration names a credential (default `HF_TOKEN`), and code
   resolves the value from the Harness vault only when a request needs it.
4. **Declare optional Harness services with `ctx.inject([...], ...)` or `inject`**, never by a
   one-time `ctx.get(...)` at startup.
   - **Why:** a service such as the command registry may start after this plugin, and
     `ctx.get` then returns `undefined` silently.
   - **History:** the private prototype lost its command this way.
5. **Separate facts from assumptions** in docs and comments. State what was verified, on which
   Harness version and date, and mark the rest as "not verified".
6. **Update the docs in the same change as the behavior:** README, design and CHANGELOG.

## 3. Repository map

| Path | Content |
|---|---|
| `README.md` | What the plugin does, credentials, configuration, compatibility |
| `docs/design.md` | Architecture, Space lifecycle, configuration schema, progress protocol, platform facts, roadmap |
| `examples/config.example.yml` | Commented configuration with fake values |
| `scripts/check-secrets.mjs` | Secret and personal-data scanner (no dependencies) |
| `.githooks/pre-commit` | Runs the scanner on staged files and the commit identity, then gitleaks when installed |
| `.githooks/commit-msg` | Runs the scanner on the commit message |
| `test/` | Offline tests (`node:test`) |
| `.github/workflows/ci.yml` | Defined workflow: tests, scanner and gitleaks. It runs only when GitHub Actions is enabled and funded for the repository, so do not rely on it as the only check |
| `llms.txt` | Short index of this repository for language models |

## 4. Commands

| Command | What it does |
|---|---|
| `npm run hooks` | Points git to `.githooks/` (run once per clone). The hooks are committed as executable |
| `npm run check` | Secret and personal-data scan of tracked files, then tests |
| `npm test` | Tests only |
| `node scripts/check-secrets.mjs --staged` | Scan staged files and the commit identity (the pre-commit hook does this) |
| `node scripts/check-secrets.mjs --message <file>` | Scan a commit message (the commit-msg hook does this) |

**Personal data is checked against a private denylist:**
- **Where:** a local file `.private-denylist`, which is git-ignored and never committed. One
  literal per line, for example your account name, Space ids, home folder name and e-mail
  domain. `DSH_PRIVATE_DENYLIST` can name another file.
- **Required to commit.** Without it, the hooks refuse to run: a missing denylist would let
  personal data through silently. If you have nothing personal to protect, create the file
  with only a comment line.
- **What happens:** the scanner refuses any staged file, commit message or commit identity
  that contains one of the terms.

**Commit identity.** Author and committer become public in history. Use your GitHub noreply
address for this repository: `git config user.email <id>+<login>@users.noreply.github.com`. The
pre-commit hook warns about any other address and refuses one that matches the denylist.

**gitleaks.** The project scanner knows the token formats this project is likely to meet;
gitleaks knows hundreds more. Install it so the pre-commit hook runs it too:
- Windows: `winget install gitleaks`;
- macOS: `brew install gitleaks`.

Without it, the hook prints a note and runs only the project scanner.

## 5. Coding conventions

- **Modules:** Node.js ES modules (`.mjs`), plain JavaScript with JSDoc types. There is no
  build step for the Host half.
- **Testable logic:** pure logic (settings, state machine, progress estimation, cost) lives in
  modules without Harness imports, so it runs under plain `node --test`.
- **Harness wiring:** a thin plugin entry over that logic.
- **Comments:** explain why, not what. Keep them short.
- **Errors shown to users:** say what happened and what to do next.

## 6. Testing

- **Unit tests:** plain `node --test`.
- **Runtime tests,** when they exist, mount the plugin on an installed DeepSeek Harness.
  - **How:** run with the app's own Electron in Node mode (`ELECTRON_RUN_AS_NODE=1`), with
    `DSH_TEST_RUNTIME_ROOT` pointing to `<app>/resources/app.asar/dsh`.
  - **Against what:** a simulated Hugging Face API and a simulated Space on `127.0.0.1`. They
    must never touch the network beyond loopback.
- **Evidence:** do not commit local test output, because it contains local paths.
  - **What to record instead:** each change states in the CHANGELOG which tests passed, on which
    operating system and Harness version.
  - **CI:** when it runs, it prints results in its log. It publishes no report files.

## 7. Definition of done

- [ ] Behavior matches docs/design.md, or the design was updated in the same change.
- [ ] `npm run check` passes locally and CI is green.
- [ ] README, design and CHANGELOG describe the change, with the Harness version it was verified on.
- [ ] No secret, personal data or real account default was added. Check the diff, not only the scanner.
