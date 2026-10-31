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
6. **Add complexity that is not essential.** Keep the plugin and this repository simple for users
   and contributors. Do not add any of these unless the feature cannot work without it:
   - hosted services, such as GitHub Actions or other CI;
   - external tools a contributor must install;
   - extra features or settings.

   Prefer Node.js built-ins and what the Harness already provides. If you believe one is
   essential, ask the maintainer first; do not add it and explain afterwards.
7. **Add a runtime dependency** without a concrete need stated in the pull request. The Host
   half uses Node.js built-ins and the packages the Harness provides.
8. **Modify a DeepSeek Harness installation** (`app.asar`, executables) or rely on its private
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
7. **Keep the plugin working when DeepSeek Harness is updated.** Follow
   [section 7](#7-compatibility-with-harness-updates) in every change.
8. **Ship it ready to use, and make setup deterministic.** Assume an AI agent installs and
   configures this plugin by following the docs.
   - **Minimal input:** the user gives a Space id and credential names. Everything else is read
     (Space API, Space manifest, hardware list) or has a tested default.
   - **One source per value,** in this order: user configuration, then the Space manifest, then
     the Hugging Face API, then a documented default. The interface shows where each effective
     value came from.
   - **Deterministic:** the same inputs always give the same routes and models. Never guess (for
     example, never build a URL from an id). When a value is missing or invalid, refuse that part
     visibly and say the fix.
   - **Agnostic within limits:** no code branch for a particular model or Space. Model-specific
     knowledge is data (a Space manifest or a configuration value), with the date it was
     verified.
   - **Install steps for agents** are commands with their expected result and a stop condition
     ("if you see X, stop and ask the user"). They never ask for a secret value in the chat.

## 3. Repository map

| Path | Content |
|---|---|
| `README.md` | What the plugin does, credentials, configuration, compatibility |
| `docs/design.md` | Architecture, Space lifecycle, configuration schema, progress protocol, platform facts, roadmap |
| `docs/contracts.md` | Phase 0 record: Hugging Face and Harness APIs the plugin depends on, with responses, verification level and date |
| `examples/config.example.yml` | Commented configuration with fake values |
| `scripts/check-secrets.mjs` | Secret and personal-data scanner (no dependencies) |
| `.githooks/pre-commit` | Runs the scanner on staged files and the commit identity |
| `.githooks/commit-msg` | Runs the scanner on the commit message |
| `src/` | Plugin code. `config.mjs`, `manifest.mjs`, `route.mjs`, `hf.mjs`, `supervisor.mjs`, `gate.mjs`, `rules.mjs`, `progress.mjs` and `messages.mjs` have no Harness imports and run under plain `node --test`; `index.mjs`, `chat.mjs`, `control.mjs` and `web.mjs` wire them into the Harness |
| `client/index.js` | Client half: a classic script, no build step, React from the Harness window |
| `cordis.patch.yml` | The bundle's default row: no Space, so nothing is registered |
| `test/*.test.mjs` | Tests (`node:test`). `runtime.test.mjs` needs an installed Harness and is skipped otherwise |
| `test/runtime-loader.mjs` | Mounts the plugin on the installed Harness for the runtime tests |
| `llms.txt` | Short index of this repository for language models |

## 4. Commands

| Command | What it does |
|---|---|
| `npm run hooks` | Points git to `.githooks/` (run once per clone). The hooks are committed as executable |
| `npm run check` | Secret and personal-data scan of tracked and new (not git-ignored) files, then tests |
| `npm test` | Tests only (`test/*.test.mjs`) |
| `ELECTRON_RUN_AS_NODE=1 DSH_TEST_RUNTIME_ROOT=<app>/resources/app.asar/dsh <app executable> --test test/runtime.test.mjs` | Runtime tests on the installed Harness (section 6) |
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

**Coverage of the scanner.** It knows the token formats this project is likely to meet. It needs
no external tool. When you handle a credential of another kind, add its format to
`SECRET_PATTERNS`, with a test.

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
  - **No CI:** there is none on purpose. Checks run locally (`npm run check` and the hooks).

## 7. Compatibility with Harness updates

**Rule:** a DeepSeek Harness update must never break this plugin.
- **Inside the tested range,** the plugin keeps working with no change.
- **Outside it,** the Harness refuses to load the plugin, visibly, instead of loading code that
  fails later.

These practices come from plugins that already went through Harness updates (0.2.0-rc.2 →
0.2.1-rc.2 on 2026-10-17, then 0.2.1-rc.3 on 2026-10-27). Each one answers a breakage that
happened.

| Practice | What it prevents |
|---|---|
| **Version gate:** `package.json` declares `engines.dsh` as one range that ends before the next minor version, with `-0`: today `">=0.2.1-rc.3 <0.3.0-0"`. Never a list of exact versions | A list of exact versions got a plugin refused on every update. A ceiling of `<0.3.0-rc.0` still admits `0.3.0-alpha.*`. When `engines.dsh` is present, only it decides admission, before the module is imported |
| **Widen the range only after testing:** move the floor or the ceiling only when the tests below passed on that Harness version. In 0.x, a new minor version is where breaking changes land | Admitting a version nobody tested |
| **Harness packages as peers:** `@deepseek-ai/cordis` and each `@deepseek-ai/dsh-*` package the plugin uses are `peerDependencies`, with the same broad range. Never regular dependencies. A package used only when present is `optional` in `peerDependenciesMeta` | A regular dependency gives the plugin its own frozen copy instead of the app's instance |
| **Inject optional services** (section 2, rule 4) | A service that starts later or is gone makes the plugin inactive instead of throwing |
| **Use only confirmed contracts:** the services, events, routes and slots in [docs/contracts.md](docs/contracts.md) for the tested version. In a waterfall the plugin does not own, call `next()`. To change a decision, spread the object received (`{ ...decision, field }`) | Code that relies on internals, and new Harness fields lost when an object is rebuilt |
| **No internal Client packages:** no `@deepseek-ai/dsh-client-ui-*` import as a component library. Own markup and CSS, colors from `--dsw-alias-*` tokens only. Use slots that add content (`list` or `keyed`, `replaceRisk: none`), never ones that hide official UI. No DOM outside the plugin's own components, no iframes | Internal UI packages and generated class names change without notice |
| **No new session-log event types** | A plugin that wrote events in an older format had them refused by the new session codec |
| **Settings survive updates:** every `Config` field has a default. A new field is optional. A renamed key keeps accepting the old name, migrated through `schemaVersion` | The user's settings outlive the update; a missing or unknown key would break them |
| **Stable identifiers:** plugin row id, provider `route` ids, command names and tool names never change | User settings and saved sessions point to them |
| **Fail visibly:** when a contract is missing, the plugin logs it, shows it in its interface state and stays inactive. It never throws into the Harness or blocks other plugins | Features that disappear after an update with no message |
| **Tests do not assume export shapes** of Harness packages: use `mod.default ?? mod` | A Harness package changed from a `default` export to `{apply, Config, name}`, and tests failed with `invalid plugin` |

**Tests that prove it** (from Phase 1, as runtime tests, see section 6):
- **Admission test:** runs the installed Harness's own rule, `evaluatePluginCompatibility` from
  `@deepseek-ai/dsh-app-boot`. It asserts that the package is admitted on the tested version
  and refused from `0.3.0-alpha.1` on.
- **Runtime tests:** the plugin mounted on the installed Harness, with the services it injects.

**After every Harness update, the maintainer:**
1. Checks the plugin manager (`plugin_manager` `list_bundles` and `list_plugins`): no
   `incompatible-version` error, and the plugin rows active.
2. Runs the runtime tests against the new installation.
3. Checks that every configuration key still exists in `Config`.
4. Checks by hand that the header indicator renders and that a start and a stop work.
5. Records the Harness version, date and results in the CHANGELOG and in the README
   compatibility table, and only then widens `engines.dsh`.

## 8. Definition of done

- [ ] Behavior matches docs/design.md, or the design was updated in the same change.
- [ ] Nothing in the change breaks section 7 (version gate, peers, confirmed contracts only).
- [ ] `npm run check` passes locally.
- [ ] README, design and CHANGELOG describe the change, with the Harness version it was verified on.
- [ ] No secret, personal data or real account default was added. Check the diff, not only the scanner.
