# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added (public repository, 2026-10-31)

- **README:** what the user sets up on Hugging Face (hardware, inference engine, weights, sleep
  time) and what the plugin does, with the engine requirements; the flow end to end, open
  models, responsible-use terms, step-by-step installation,
  and a FAQ written as people ask (own model in DeepSeek Harness, uncensored models, idle GPU
  cost, cold start, privacy, balance, agents, updates).
- **Discoverability:** 20 GitHub topics, `homepage`, `bugs` and more `keywords` in
  `package.json`, and the package attached to each GitHub release, so it installs without
  building it.

### Changed (interface redesign, 0.1.0-alpha.8, after the first Desktop test)

- **Header indicator: one short line.** The whole progress sentence and three buttons overflowed
  the narrow header and covered the session title and chips (seen on the Desktop on
  2026-10-31). Now: state dot, Space name, a short state ("starting 42% · ~2 min",
  "serving · until 13:48"), a small progress meter, and one action (Start or Stop). The state is
  a button that opens the sidebar tab; the full line is its tooltip. Extending moved to the
  time-limit notice and the sidebar tab.
- **Sidebar tab as a detail page:** state and action first; then the stage with percent, time
  left and a progress bar, or the facts of the start (time on, cost so far, stop time with +N,
  idle rule); then what this Space was billed today and this month, labelled as spending and
  not as the balance; then the recent starts in aligned columns. The run log and the credentials
  are folded, and the credentials open by themselves when one needs a fix.
- **Notices look like the Harness's own** (its toast surface and elevation tokens). Only what
  needs an action or blocks a Space; a button's answer disappears after 5 s unless it is an
  error, and waits while the pointer is over it; a closed failure or effort notice stays closed
  after a reload.
- **Setup page:** configuration problems first, then each credential and each check with a word
  and a color (ok, check, fix), then the values in use with their source, on the Harness's
  settings-card surface.
- **Style:** one scoped style sheet (`dhs-` classes) with the Harness theme tokens only, focus
  rings, tabular numbers and no motion under prefers-reduced-motion. A missing token used before
  (`--dsw-alias-label-error`) is replaced by the Harness's `--dsw-alias-state-error-primary`,
  so errors are red again.
- **Accessibility:** the state is announced once per change, never at each percent; the status
  button's name starts with what it shows; every close button says what it closes.
- **The interface reads the plugin every 5 s** (2 s while a Space starts or stops), so a start
  begun from the chat shows within seconds.
- **The first start phase is "Starting the Space"**, not "Waiting for a Hugging Face GPU": it
  covers the GPU wait and the container boot until the Space prints its first progress line.

### Added (Phase 2 complete and Phase 3, 0.1.0-alpha.7)

- **Sidebar tab** "Hugging Face Spaces" (`sidebarRightTabs` + `sidebar.right.pane.tab`), also on
  the sidebar's start page: one card per Space with state and buttons, progress bar, time on,
  stop time, what Hugging Face billed today and this month, the last 5 starts (duration, cost,
  why each ended) and the run-log tail of the last start; then the state of each credential.
- **Setup page** in the Plugins panel (`plugins.bundle.config`): configuration problems, each
  credential, and per Space what was read, whether the models were served, the effort check, and
  each effective value with its source. Served by `GET /dsh-hf-spaces/setup`, guarded like the
  other routes.
- **Header indicator on the default model:** a session that never picked a model, and so runs on
  the profile default, now shows the indicator, through the model-selection service. A Details
  button opens the sidebar tab.
- **Credential checks** (`GET /api/whoami-v2`, once per token, never polled): in the vault or not,
  accepted or not, account and token role. A missing or refused inference or control credential
  is a toast.
- **Billing usage** (`usage-v2`, billing credential): each Space today and this month, read in the
  background every 10 minutes at most, in the sidebar and in `/space status`.
- **Start records** in `<Harness home>/state/dsh-hf-spaces/ledger.json` (`stateDir` changes it):
  when each start began, was ready and ended, why, hardware and cost; the last 50, no secrets.
- **Migration:** the plugin replaced its private prototype in a real profile, on the same route
  (`rvn`), so sessions bound to it keep working.

### Changed

- **No background job for the progress.** The start progress shows only in the header indicator
  and the sidebar tab; the chat notice points there. The prototype's start task sat behind a
  collapsed "1 background job running" line, where the user did not find it. Stopping a start is
  the Stop button or `/space off`.
- **A failed start keeps its reason on screen** until the next start: the failed start is paused,
  and the next read of the Space, "off", no longer hides why it failed.
- **The interface needs only `slots`.** Every other Harness service is optional; a Harness
  version without one only loses that part.
- **No account balance.** Hugging Face does not expose it through the API, so the plugin shows
  what was billed instead (decided with the user on 2026-10-31).

### Fixed

- `/space status` said "off" during the first moments of a start, and wrote "estimated cost
  undefined" before the hardware price was read (runtime tests).
- The runtime tests wrote their start records under the real Harness home; each test environment
  now uses a temporary `DSH_HOME`.
- **Code review of this version:**
  - a Space found serving (started elsewhere, or running when the Harness opened) had no idle
    rule until its first request, so it could bill until its own sleep time; it now gets the idle
    rule at once;
  - a configuration change while a Space served dropped its stop rules, last failure and effort
    check; they now carry over;
  - a session closed while the Space started was still woken when it was ready;
  - an old failure stayed on screen after the Space was started elsewhere and served;
  - a start that failed before ready, on the Space's own hardware, had no cost; it is now costed
    on the hardware it asked for;
  - a start only seen serving is marked as such, and its cost shown as a minimum;
  - the interface no longer waits for the hardware price list, billing figures say when they are
    stale, one token shared by several credentials is checked once, the vault is read at most
    every 10 s for the credential view, the setup page is keyed by route, and a relative
    `stateDir` is under the Harness home.

### Added (Phase 2, slice 6: the interface, 0.1.0-alpha.6)

- **Start variables** (`start.variables`, or `startVariables` in the manifest): Space variables
  the plugin writes before each start it makes, declared as data with the placeholders
  `{{uuid}}`, `{{now}}` and `{{readyDeadline}}` (Unix seconds). For Spaces with a start
  handshake: the private prototype's Space pauses itself at boot unless a fresh session variable
  with a start deadline was written first. No Space-specific code. Space variables are not
  secret, so a value holding a token is refused; only the three placeholders are replaced.
- **Client half** (`client/index.js`): a classic script with no build step, loaded by the Harness
  with React from its own window, in the same format as the official open-in-app client.
  - **Header indicator** (`conversation.session.header.utilities`), only in sessions whose model
    belongs to a configured Space: state, progress with percent and time left, time on and cost,
    stop time, and Start, Stop and +N buttons.
  - **Toasts** (`shell.overlay`): time limit soon (with +N and Stop), a failed start, refused
    effort levels. Each can be closed. Colors come from the Harness theme tokens only.
  - One shared poll of the plugin's state: every 2 s while a Space starts or stops, else every
    15 s, and only while something is on screen.
- **Local routes** (`src/web.mjs`): `GET /dsh-hf-spaces/state` and
  `POST /dsh-hf-spaces/action`, each request checked first with the Harness guard
  (`connection.requestRejection`), small bodies only, actions limited to on, off and extend.
- **Tests:** the routes with a fake web server (guard, methods, actions), and the client script
  run as the Harness loads it, with a minimal React stand-in (header text, toasts, what a button
  sends). The look is checked by hand on the Desktop.
- **Code review of the slice:** 7 findings; 6 fixed. A button's answer (a refusal, an unconfirmed
  pause) now shows as a toast; one poll at a time however often components remount; the state
  of a Space changed elsewhere is read again at most once a minute. Not yet verified: how the
  session's model is read for the indicator (the path used by the official agent-team client),
  checked by hand on the Desktop.

### Added (Phase 1, slice 5: precise progress and the effort check, 0.1.0-alpha.5)

- **Start progress** (`src/progress.mjs`): phase, percent and time left in the start task, from
  the Space stage, the `progress.eventPrefix` lines of its run log (the copy uses the measured
  bytes and rate) and the warm-up. Estimates generalized from the prototype's real starts.
- **Run log** read from Node while the Space starts (`followRunLog`), opened only once it left
  the paused stage, because a paused Space answers that request with nothing at all.
- **Effort check and warm-up** (design, section 6, step 6): when the server lists the models,
  one minimal request per configured effort level, which also warms the model. A level the
  server refuses (HTTP 400, 422 or 500) is reported in the log and in `/space status`, with the
  fix. Requests that arrive meanwhile wait with the others instead of queueing behind it.
- **Tests:** progress estimate and event lines; a runtime test with run-log events, the effort
  check and a refused level. Testing found that the log was opened while the Space was still
  paused, which hid the copy; fixed.

### Added (Phase 1, slice 4: /space and the stop rules, 0.1.0-alpha.4)

- **`/space [status | on | off | +N] [route]`** (`src/control.mjs`): never sends anything to a
  model. The route is needed only when several Spaces are configured; the plugin never guesses.
  - `status`: state, hardware, time on, estimated cost, when it stops.
  - `on`: starts the Space with a progress job in the session, without resuming it (a resume
    would open a model turn); a manual start ignores the failure cooldown.
  - `off`: pauses and reports the estimated cost, or the warning when the pause is unconfirmed.
  - `+N`: extends the time limit of a start made by the plugin.
- **Stop rules** (`src/rules.mjs`), per Space in `stop`: `idleMinutes` 30 (idleness counts from
  the end of the last answer), `sessionMinutes` 60 counted from the start, `warnMinutes` 5,
  `extendMinutes` 60. At the time limit a recent request may finish for up to 10 minutes. A Space
  started elsewhere gets the idle rule only.
- **Start line** states the stop rules with their real conditions: they apply only while the
  Harness is open, and when it is closed only the Space's own sleep time stops it.
- **Cost** as Hugging Face bills it: every started minute, at the public price of the hardware.
- **Tests:** stop rules and command syntax; runtime tests of `/space` (no model request at all),
  of the idle pause, of the time limit, and of `/space off` on a Space started elsewhere.
- **Code review of the slice:** 8 findings; 7 fixed. `/space off` and `/space status` now read
  the Space instead of trusting the last known state, which could leave a Space started on the
  website billing. The warning before the time limit shows only in `/space status` until the
  interface slice. Testing also found that a start counted as use and delayed the time limit.
- **README:** the Hugging Face PRO plan is recommended (Docker Spaces on GPU need a paid plan,
  1 TB of private storage, included compute credits), with a prepaid balance or automatic
  recharge for the GPU itself, which is billed apart from PRO. Read on the official pages on
  2026-10-31.

### Added (Phase 1, slice 3: start from the chat, 0.1.0-alpha.3)

- **Chat gate** (`src/chat.mjs`, pure parts in `src/gate.mjs`): a conversation request to a
  Space that does not serve starts it and is answered with one line written as the plugin. That
  line says where progress shows ("background job" at the top of the conversation).
  - **Resume:** when the Space is ready, each waiting session gets one plugin notice that quotes
    the user's waiting message, and the model answers it.
  - **Progress job** in each waiting session's header, with the Space stage and elapsed time. Its
    stop control pauses the Space; a user stop is not a failure (no cooldown, no chat turn).
  - **Failure:** no chat turn is opened; the reason shows in the start task, and the next message
    explains the 10-minute wait before another automatic start.
  - **Never starts** for other requests (session titles), without the inference or the control
    credential (the notice names the missing one and how to add it), or when `start.automatic` is
    false (the notice gives the start command).
  - **A failed probe is not proof the Space is off:** the gate reads the Space stage first. A
    running or starting Space is joined with an "is starting" notice, never restarted.
  - **Configuration change during a start:** the new entry takes over the waiting sessions and
    their progress jobs, so they still resume.
- **Code review of the slice:** 10 findings; 9 fixed, 1 left for slice 4 (the start line will state
  the stop rules once those rules exist).
- **Messages** in English or Brazilian Portuguese (`locale`).
- **Settings:** `locale`, `pollSeconds`, and `start.automatic` per Space.
- **Tests:** gate and messages tests, plus runtime tests with the real agent loop and jobs
  registry: start and resume quoting the user, a Space already serving, a failed start, and the
  stop control.

### Added (Phase 1, slice 2: start and pause a Space, 0.1.0-alpha.2)

- **Space supervisor** (`src/supervisor.mjs`, no Harness imports): states off, starting, ready,
  stopping and failed.
  - **Start:** a paused Space is restarted, or moved to the configured `hardware` when it differs
    (Hugging Face restarts it there). Two starts at once share one.
  - **Ready** only when the Space's own `GET /v1/models` lists every configured model. A server
    that lists other models fails at once, with the fix.
  - **Safety:** a start that reports an error stage, or is not ready after
    `start.readyTimeoutMinutes` (default 15), pauses the Space, but only when this start began
    it; a Space started elsewhere is reported and left as it is. A credential the Space refuses
    ends the wait at once instead of billing until the timeout.
  - **Never stale:** every start reads the Space again, so a Space paused on the web or asleep
    after its sleep time is started again.
  - **Stop:** pauses and waits for Hugging Face to confirm (stopped stage, no hardware). An
    unconfirmed pause, or a refused pause request, is reported as a possible cost, never as "off".
    A stop cancels a start and wins over it. An already paused Space is not paused again.
- **Hugging Face client:** Space state, restart, pause and hardware change. Reads use the
  inference credential; start, pause and hardware use the control credential. The model list is
  read only from the Space's own address.
- **Plugin:** each registered Space gets a supervisor that reads and logs its state at startup.
  Starting from the chat comes in slice 3.
- **Configuration limits** are checked per Space, not in the schema, so one bad value refuses
  that Space instead of the whole plugin. Error messages say what to do next.
- **Tests:** 20 supervisor tests on a fake clock (minutes of waiting run in milliseconds), 3 more
  Hugging Face client tests and 1 configuration test.
- **Code review of the slice:** 13 findings, all fixed. One more defect surfaced while testing
  the fixes: a stop asked during a state change repeated itself without end; the operation is
  now recorded before it runs. Real Hugging Face calls are still
  unverified from Node; that comes with the real-start test at the end of Phase 1.

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
