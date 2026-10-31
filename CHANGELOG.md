# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added (Phase 1, slice 1: Spaces in the model selector, 0.1.0-alpha.1)

- The package is a Harness bundle: `engines.dsh` `>=0.2.1-rc.3 <0.3.0-0`, Harness packages as
  peers, and a default `cordis.patch.yml` row with no Space.
- **Configuration** (`src/config.mjs`): only the Space id is required. Route from the label,
  credential names (never values), `baseURL` https only, ordered reasoning levels. A bad Space or
  model is refused alone, with the fix in the message.
- **Space manifest** (`src/manifest.mjs`): `dsh-hf-spaces.json` read while the Space is stopped,
  and one effective value per field in the order configuration, manifest, Hugging Face API,
  default, each tagged with its source.
- **Hugging Face client** (`src/hf.mjs`): Space info and repository files, tokens only to
  huggingface.co (or this machine in tests), no redirect followed with a token, Space files
  capped at 64 KiB.
- **Model selector** (`src/route.mjs`, `src/index.mjs`): one provider route per Space, each in
  its own `dsh-llm-pi-ai` instance, so a problem with one Space never removes another. A route
  another provider already serves is refused for that Space alone. Spaces are read in parallel,
  and startup reads Hugging Face once. Routes carry the open model name, the effort levels in
  order and `medium` as the default effort when every model lists it. Reuses the Harness's own
  adapter instead of new wire code.
- **Credentials:** read only through the Harness credential service, which already falls back to
  the launching environment. `baseURL` must be a Space address (`https://<subdomain>.hf.space`),
  because the inference token is sent there. A token pasted where a credential name belongs is
  refused, and the message does not repeat it.
- **Tests:** 27 offline tests for the new modules, plus 5 runtime tests on the installed Harness
  0.2.1-rc.3 (admission, model list and effort levels, Space id only with a manifest, a taken
  route refused alone, routes removed on dispose). Windows, 2026-10-30.
- **Code review of the slice:** 14 findings; 13 fixed, 1 kept as a documented risk (the
  no-op wrappers over pi-ai's internal registrations, docs/contracts.md).

### Added (scaffold and design)

- Repository scaffold:
  - README, instructions for AI agents and contributors (`AGENTS.md`), `llms.txt`;
  - MIT license, security policy;
  - commented configuration example.
- Design document: architecture, Space lifecycle, credentials, configuration schema, progress
  protocol, roadmap.
- Secret and personal-data scanner (`scripts/check-secrets.mjs`), a pre-commit hook and tests.
- Rule for contributors: no complexity that is not essential (hosted CI, external tools, extra
  dependencies or features) without the maintainer's approval.
- Rule for contributors: a DeepSeek Harness update must never break the plugin (AGENTS.md,
  section 7). It covers the version gate, Harness packages as peers, confirmed contracts only,
  settings that survive updates, an admission test and a checklist after each update.
  `package.json` declares `engines.dsh: ">=0.2.1-rc.3 <0.3.0-0"`.
- Phase 0 contract record (`docs/contracts.md`), 2026-10-30:
  - Hugging Face Space endpoints checked read-only;
  - DeepSeek Harness 0.2.1-rc.3 plugin APIs read in the installed package (admission verified);
  - for each open item, whether the limit is the provider's or ours.

### Changed (from Phase 0)

- **Header indicator** moves to `conversation.session.header.actions`: `.corner` is a single slot
  the Harness already uses.
- **Hourly price** is read from the public hardware list; a configured price is only an override.
- **Settings:** the Harness draws no page from the schema, so the plugin will register its own.
- **Routes:** every plugin route is guarded with `ctx.connection.requestRejection`.
- **Ready to use, deterministic setup** (AGENTS.md rule 8; design, section 6): minimal input
  (Space id and credential names), one source per value in a fixed order, no guessing, no
  model-specific code. An optional Space manifest, `dsh-hf-spaces.json`, describes the models and
  is read while the Space is stopped (verified on 2026-10-30). The 1.0 exit criterion now
  includes an AI agent setting the plugin up from the install guide alone.
- **Model selector flow** (design, section 6): provider group from `label`, the open model's
  name, listed while the Space is stopped, effort levels from configuration in order, checked at
  load and against the running Space (one-token request per level), live refresh, and tests.
  It is part of the Phase 1 exit criterion.
- **Start line in the chat** (from a real start of the prototype on 2026-10-30): it points to a
  place the user can see, in the screen's words, and states the stop rules with their real
  conditions (time limit counted from the start; rules only while the Harness is open). The
  interface also shows the Space's sleep time, the only limit when the Harness is closed.

### Removed

- GitHub Actions workflow. It was not essential; checks run locally (`npm run check` and the
  hooks).
- gitleaks, its configuration and its optional run in the pre-commit hook. It was an external
  tool; the project scanner needs nothing installed.

### Fixed (code review of the scaffold)

- **Hooks:** committed as executable, so they run on macOS and Linux too.
- **Scanner coverage:** more token formats (Stripe, Google, Telegram, JWT, npm `_authToken`,
  generic secret assignments, case-insensitive bearer).
- **Personal data:** commits fail closed without a private denylist; a `DSH_PRIVATE_DENYLIST`
  that points to a missing file is an error.
- **Commit identity:** a `commit-msg` hook scans the message, and the pre-commit hook scans the
  author and committer identity.
- **Encodings:** UTF-16 files (with or without BOM) are decoded and scanned instead of being
  skipped as binary.
- **Path patterns:** fewer false positives (shared Windows folders, placeholders, URL paths).
- **CLI:** the scanner's command line has tests, and the main-module check works through
  symlinks.
- **New files:** `npm run check` also scans new files that are not staged yet (git-ignored files
  stay out). Before, a new document passed the check without being read.
- **Design:**
  - the Space base URL comes from the Space API host;
  - explicit `route` provider id;
  - configurable progress-event prefix, with no built-in alias for a particular Space;
  - model-specific reasoning mapping in the example.
- **Docs:**
  - security behavior is marked as planned, not implemented;
  - more credential files are git-ignored (`.npmrc`, `.netrc`, `.pypirc`, SSH keys,
    certificates).
