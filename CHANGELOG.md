# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository scaffold:
  - README, instructions for AI agents and contributors (`AGENTS.md`), `llms.txt`;
  - MIT license, security policy;
  - commented configuration example.
- Design document: architecture, Space lifecycle, credentials, configuration schema, progress
  protocol, roadmap.
- Secret and personal-data scanner (`scripts/check-secrets.mjs`), a pre-commit hook and tests.
- Rule for contributors: no complexity that is not essential (hosted CI, external tools, extra
  dependencies or features) without the maintainer's approval.

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
- **Design:**
  - the Space base URL comes from the Space API host;
  - explicit `route` provider id;
  - configurable progress-event prefix, with no built-in alias for a particular Space;
  - model-specific reasoning mapping in the example.
- **Docs:**
  - security behavior is marked as planned, not implemented;
  - more credential files are git-ignored (`.npmrc`, `.netrc`, `.pypirc`, SSH keys,
    certificates).
