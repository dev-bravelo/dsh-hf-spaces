# Design: dsh-hf-spaces

Status: **design, pre-alpha.** Written on 2026-10-30 against DeepSeek Harness Desktop
**0.2.1-rc.3**.

Every fact below is marked with its source and verification level:
- **Verified:** observed running.
- **Read:** read in official docs or in the Harness package source.
- **Planned:** not built yet.

## Contents

1. [Goal and non-goals](#1-goal-and-non-goals)
2. [Platform facts](#2-platform-facts)
3. [Architecture](#3-architecture)
4. [Space lifecycle](#4-space-lifecycle)
5. [Credentials](#5-credentials)
6. [Configuration schema](#6-configuration-schema)
7. [Start progress protocol](#7-start-progress-protocol)
8. [Behavior in the chat](#8-behavior-in-the-chat)
9. [Interface](#9-interface)
10. [Lessons from the private prototype](#10-lessons-from-the-private-prototype)
11. [Roadmap](#11-roadmap)
12. [Open questions](#12-open-questions)

## 1. Goal and non-goals

**Goal.** A user with a GPU Hugging Face Space that serves an OpenAI-compatible API can pick its
models in the DeepSeek Harness model selector and use them as if they were always available.
- The Space starts on demand, stops when idle or at a time limit, and bills only while used.
- State, progress and cost are visible in the Harness interface.
- Manual controls never wake the model.

**Non-goals for 1.0:**
- Building or publishing the Space itself. A reference Space template may come later.
- Hosts other than Hugging Face Spaces. The supervisor is written so that another backend
  (Inference Endpoints, a cloud VM) could be added behind the same interface.
- Several concurrent conversations on a single-slot server.

## 2. Platform facts

### Hugging Face Spaces (read 2026-10-30 in the official docs; verified on a private Space)

| Fact | Source | Consequence for the plugin |
|---|---|---|
| The local disk "will be lost if your Space restarts or is stopped". An A100 large has 1000 GB of it | [spaces-storage](https://huggingface.co/docs/hub/spaces-storage), [spaces-gpus](https://huggingface.co/docs/hub/spaces-gpus). Verified: every start re-copied the weights | Starting always re-reads the weights. Progress must show the copy |
| Storage Buckets mounted as volumes persist and are "the recommended way to persist data". They are read over the network, on demand | [storage-buckets](https://huggingface.co/docs/hub/storage-buckets) | Typical weight source. Verified copy rate: ~240 MiB/s, about 90 s for 22.5 GB |
| Paused time is not billed; a Space stays paused "until manually restarted" | [spaces-gpus](https://huggingface.co/docs/hub/spaces-gpus) | The plugin stops a Space by pausing it, so a stray visit cannot wake it |
| Sleep (after the configured inactivity) is not billed, and a Space wakes "once it receives a new visitor" | Same | Sleep is only a safety net when the Harness is closed |
| Hardware is billed per minute while Starting or Running | Same. Verified: `usage-v2` reports minutes | Cost estimate = minutes × hourly price |
| A paused Space keeps no hardware reserved; a restart may wait for a free GPU | Verified (an L40S was unavailable twice) | The first phase, "Starting the Space", covers the wait for a GPU and the container boot, until the Space prints its first progress line |
| The account balance is not available through the API, only on the logged-in billing page. Usage is (`/api/settings/billing/usage-v2`, Unix seconds) | Verified 2026-10-27 | The plugin shows what was billed (each Space today and this month, each start), never a balance. Decided with the user on 2026-10-31: no balance entered by hand |

The Space endpoints, their responses and what was verified on 2026-10-30 are in
[contracts.md](contracts.md), section 1. Two facts from there change the plan:
- the hourly price of each hardware is public (`GET /api/spaces/hardware`);
- the run log stays silent while a Space is paused, so it is read only while starting or
  running, with a timeout.

### DeepSeek Harness 0.2.1-rc.3 (read in the installed package; partly verified)

| Fact | Level | Consequence |
|---|---|---|
| The window is a web app built from Client plugins mounted in declared slots. Customizing the UI means writing a Client plugin | Read | Interface = Client half, not chat messages |
| Slots for the plugin: `conversation.session.header.utilities` (list, used by the official open-in-app plugin), right-sidebar tabs (`sidebarRightTabs` + `sidebar.right.pane.tab`), `shell.overlay` (list). `conversation.session.header.corner` is a single slot already used by the Harness. Details in [contracts.md](contracts.md), section 2 | Read | Indicator, sidebar tab, toasts |
| A Host plugin can serve local HTTP routes (`webServer.register`) and stream events. Routes outside `/api` get no Harness fence; the official guard is `ctx.connection.requestRejection(req)` | Read; a community plugin serves routes this way with its own, weaker check | State and actions for the Client half, every route guarded |
| Credentials: configuration names a credential; `ctx.credentials.describe(ref)` reports whether it is set and where from, never the value; `credentials/reference-updated` signals changes | Read | Clear credential status in the UI; key rotation without restart |
| `ctx.get(name)` returns `undefined` for a service whose plugin is not active yet; `ctx.inject([...], cb)` waits for it | Read in Cordis, and verified (see section 10) | Every optional service is injected |
| Slash commands (`ctx.commands.register`) run without a model message, and their result renders as a chat row. In an empty session, nothing was visible | Verified | Commands are at most a shortcut, never the main interface |
| Admission: when `package.json` declares `engines.dsh`, only that range decides whether the Harness loads the plugin, before importing it. Pre-releases count in the comparison. A refused bundle is skipped and reported as `incompatible-version` | Read on 0.2.1-rc.2; seen when other plugins were refused on the 2026-10-17 and 2026-10-27 updates | The plugin survives updates inside its range and is refused visibly outside it ([AGENTS.md, section 7](../AGENTS.md#7-compatibility-with-harness-updates)) |

## 3. Architecture

```
 Harness window (Client half)                    Harness backend (Host half)
 ┌──────────────────────────────┐   loopback   ┌──────────────────────────────────────┐
 │ header indicator   ◄─────────┼── state ─────┤ routes: GET state · GET setup        │
 │ sidebar tab · setup page     │              │         POST start/stop/extend       │
 │ toasts             ──────────┼── actions ──►│                                      │
 └──────────────────────────────┘              │ supervisor (one per Space)           │
                                               │   state machine · idle/time limit ·  │
 Model selector ◄── provider route per Space ──┤   cost · billing usage · records     │
                                               │ HF client (fetch, Node built-ins)    │
                                               └───────────────┬──────────────────────┘
                                                               │ HTTPS + token
                                                Hugging Face API · Space (OpenAI API)
```

- **Provider route:** one per Space, registered through the Harness LLM adapter.
- **Gate before each model request:** if the Space is not serving, the supervisor starts it
  (when allowed) and the request ends with a short fixed reply. When the Space is ready, the
  session is resumed (section 8).
- **No external runtimes:** no Python, no shell scripts, no CLI. Everything goes through `fetch`
  to Hugging Face.

## 4. Space lifecycle

States: `off` → `starting(stage, percent, secondsLeft)` → `ready` → `stopping` → `off`, plus
`failed(reason)`.

| Transition | Trigger |
|---|---|
| off → starting | Model request with `start.automatic`, or the Start button |
| starting → ready | `GET /v1/models` on the Space lists every configured model, and the optional warm-up finished. A server that answers with other models is a configuration error and fails at once |
| starting → stopping → failed | The Space reported an error stage, or `start.readyTimeoutMinutes` passed. The plugin pauses the Space so it does not bill without serving, and the failure says whether the pause was confirmed |
| ready → stopping | Idle for `idleMinutes`, or the time limit was reached, or Stop was pressed |
| stopping → off | Pause confirmed by the runtime API (stage `PAUSED`, no hardware) |

Further rules:
- **Time limit:** counted from the start made by this plugin. A warning comes `warnMinutes`
  before it, and Extend adds `extendMinutes`. If an answer is streaming, or a model request
  happened within the last few minutes, the pause waits up to 10 minutes for the turn to finish.
- **Start variables:** before a start it makes, the plugin writes the Space variables declared in
  `start.variables` (or the manifest's `startVariables`), rendered from placeholders. A Space that
  needs a fresh deadline or session id at each boot declares it as data.
- **Space started outside the Harness** (or running when the Harness opened): idle rules only,
  counted from the moment the plugin sees it serving, with or without a request; no time limit.
- **Configuration change:** the stop rules, the last failure and the records carry over to the
  new entry.
- **Harness closed while the Space runs:** the plugin cannot pause it. The Space's sleep time
  (`gcTimeout`, read from the runtime API) is then the only limit, and the interface shows it
  next to the plugin's own rules.
- **After a failed start:** no automatic retry for a cooldown period. A manual Start ignores the
  cooldown.
- **Records:** each start (when it began, was ready and ended, why it ended, hardware and cost)
  is kept in `ledger.json` in the plugin's state folder, `<Harness home>/state/dsh-hf-spaces`,
  the last 50 only and no secrets. A start still open when the Harness closed shows "end not
  seen". The records feed the sidebar tab.

## 5. Credentials

| Setting | Required | Purpose | HF token permission |
|---|---|---|---|
| `credentials.inference` | yes | Model requests to a private Space | Read the Space |
| `credentials.control` | to start/stop | Pause, restart, read runtime and logs | Write the Space |
| `credentials.billing` | no | `usage-v2`: what each Space was billed today and this month | Read billing |

How they are handled:
- **Names, not values:** each setting is a credential **name** (default `HF_TOKEN`), resolved
  from the Harness vault when a request needs it, and never stored by the plugin.
- **Status in the interface:** in the vault or missing, accepted by Hugging Face or not, its account and token role (`GET /api/whoami-v2`, once per token, never polled), never the value.
- **What the plugin does when one is missing:**
  - without `inference`, the provider is listed but answers with what to configure;
  - without `control`, automatic start and the buttons are disabled, with the reason;
  - without `billing`, cost comes from the hourly price only, and the sidebar says billing was not read.
- **Where tokens travel:** only to `https://huggingface.co` and to the Space's
  `https://*.hf.space` host. `http://` is refused except for `localhost`, used by offline tests.
- **Redirects:** never followed with a token attached.

## 6. Configuration schema

See [examples/config.example.yml](../examples/config.example.yml). Rules:
- **Required per Space:** only `id` (`owner/name`).
- **Route:** the provider id the Harness stores in each session. It is lowercase letters, digits
  and `-`, 1 to 32 characters.
  - **Default:** derived from `label`, lowercased, with every other character replaced by `-`.
  - **Explicit `route`:** required when that derivation is empty or longer than 32 characters.
  - **Changing it later** orphans the sessions bound to the old id, so set it explicitly for a
    Space you already use, for example when migrating from another plugin.
- **Base URL:** `https://<host>/v1`, where `host` comes from the Space API
  (`GET /api/spaces/{id}`, fields `host` and `subdomain`, seen 2026-10-30), unless `baseURL` is
  set.
  - **Do not build it from the id.** Hugging Face lowercases the name, replaces `_` and `.` with
    `-`, and shortens long names with a hash, so `<owner>-<name>` is often wrong.
  - **If the API cannot be read,** the plugin reports it and does not guess.
- **Model ids:** must match `GET /v1/models` on the Space.
- **No real values as defaults:** an empty `spaces` list means the plugin loads and registers
  nothing.
- **Schema version:** the configuration carries `schemaVersion`, and old keys are migrated with a
  log line.
- **Descriptions:** every field has one in English (more locales may follow). The Harness draws
  no page from the schema. The plugin's own page (`plugins.bundle.config`) shows the effective
  values and checks; the field descriptions are in the README and the example file.

### Ready to use: where each value comes from

The plugin must work from the smallest input a user (or an AI agent installing it) can give: a
Space id and the credential names. Every other value has one source, in this order:

| Order | Source | Holds |
|---|---|---|
| 1 | User configuration | Anything the user wants to override |
| 2 | Space manifest (optional file in the Space repository, below) | Models, names, context sizes, effort levels, progress prefix, the Space's own idle pause |
| 3 | Hugging Face API | Base URL (`host`), stage, hardware and its price, sleep time, revision (`sha`) |
| 4 | Documented default | The rest, for example `idleMinutes: 30` |

Rules:
- **Shown, not hidden:** the interface lists each effective value with its source, so a wrong
  value can be traced to the place that set it.
- **No guessing:** a value no source provides is not invented. That part is refused with the fix,
  for example "no model listed: add `models` to the configuration or a manifest to the Space".
- **No model-specific code:** what differs between models and servers lives in the manifest or
  the configuration, as data.

### Space manifest (optional)

A Space can describe what it serves in a file at the root of its repository,
`dsh-hf-spaces.json`. The plugin reads it while the Space is stopped, so it can list the models
without starting the GPU.

- **How it is read:** `GET https://huggingface.co/spaces/{id}/resolve/{sha}/dsh-hf-spaces.json`
  with the inference credential, pinned to the revision `sha` from `GET /api/spaces/{id}`. It is
  read again only when `sha` changes.
- **Verified 2026-10-30** on a paused private Space: a configuration file in the Space
  repository came back in 140 ms with the token (HTTP 200), and HTTP 401 without it. The Space
  stayed paused. `GET /api/spaces/{id}` also lists the repository files (`siblings`), so a missing
  manifest is known without a failed request.
- **Contents, version 1:**

```json
{
  "schemaVersion": 1,
  "models": [
    {
      "id": "model-id-as-listed-by-v1-models",
      "name": "Open model name",
      "contextWindow": 131072,
      "maxTokens": 32768,
      "reasoning": { "off": "none", "low": "low", "medium": "medium", "xhigh": "xhigh" }
    }
  ],
  "progress": { "eventPrefix": "SPACE_EVENT" },
  "idleSeconds": 3600
}
```

- **Field meanings:** as in the configuration (section 6). `idleSeconds` is the Space's own
  pause after inactivity, which the interface shows as the only limit when the Harness is closed.
- **Validation:** same rules as the configuration. An invalid manifest is reported and ignored
  as a whole, never applied in part.
- **Without a manifest,** the user lists the models in the configuration.

### Model names and reasoning efforts in the selector

The path from configuration to the Harness model selector must be complete and orderly. Every
step below is part of the Phase 1 exit criterion. Contracts: [contracts.md](contracts.md),
section 2, "Model selector".

| Step | Rule | Why |
|---|---|---|
| 1. Provider group | Each Space is one provider route. Its `label` becomes the route's `displayName`, the group heading in the selector | The user sees where the model runs |
| 2. Model name | Each model's `name` is the open model's name as people know it (for example "Qwen3.8 27B"). It is the row in the selector and the text in the composer. Without `name`, the `id` is shown. The name never carries the effort level | The selector shows the catalog name as it is |
| 3. Listed while stopped | Names and efforts come from the configuration or the Space manifest, so the model can be picked while the Space is paused. Picking it never starts the Space; only sending a message does | No network call and no cost to choose a model |
| 4. Effort levels | `reasoning` maps each Harness level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to the value the server accepts, listed from least to greatest effort. `false` means no reasoning control, and the selector then shows no Effort row. The selector offers only these levels; it has no free input | The server rejects values its chat template does not know |
| 5. Checked at load | An unknown level name, an empty value or an empty map refuses that model, with the reason in the log and in the plugin's interface. Nothing is dropped silently | Rule "fail visibly" (AGENTS.md, section 7) |
| 6. Checked against the Space | When the Space is ready, the model `id` must appear in `GET /v1/models`, and each configured level is tried once with a one-token request. A rejected level is shown in the interface, with the fix: remove it from `reasoning`. Results are kept per configuration and Space revision (`sha` from `GET /api/spaces/{id}`), so the check runs again only after a change | A llama.cpp Qwen template answered HTTP 500 to `minimal`, `high` and `max` (tested 2026-09-21), so a rejection is visible and testable |
| 7. Live update | A change to names or levels in the configuration registers the route again, and the selector refreshes by itself on `llm/adapters-updated`, with no restart | The user sees the change at once |
| 8. Tests | Offline: the route built from the example configuration has the exact names and the levels in order. Runtime, on the installed Harness: the session's model list shows the model name and only those levels | Proof that steps 1 to 7 hold |

## 7. Start progress protocol

**Generic progress, any Space.** It comes from the runtime stage (`BUILDING` → `APP_STARTING` →
`RUNNING`) and then from `/v1/models`. Percent and time left use typical phase lengths.

**Detailed progress, optional.** The Space prints JSON event lines to its run log, which the
plugin reads through `/api/spaces/{id}/logs/run`. The line prefix is `progress.eventPrefix` in
the Space configuration, default `SPACE_EVENT`:

```
SPACE_EVENT {"stage": "copy_progress", "artifact": "model", "bytes": 4420796416, "total_bytes": 22533850592, "seconds": 20.0}
SPACE_EVENT {"stage": "loading"}
SPACE_EVENT {"stage": "ready"}
```

How the plugin uses them:
- **Copy:** `bytes` and `total_bytes` give an exact copy percentage, and the measured rate gives
  the time left.
- **Format:** unknown stages are ignored, and lines with other prefixes are not parsed.
- **Other prefixes:** a Space that already prints events under another prefix sets it in its own
  configuration. The plugin ships no built-in aliases for particular Spaces.

## 8. Behavior in the chat

Only what a model request strictly needs:

1. **A message arrives while the Space is stopped.** The request is answered with one short
   fixed line, written as the plugin, never as the assistant, for example: "dsh-hf-spaces is
   starting My LLM; follow the progress in the header". Then the turn ends. The line must:
   - **point to a place the user can see,** in the words the screen uses. The prototype pointed
     to a background task by its label, but the screen showed only a collapsed "1 background
     job running", and the user did not find it;
   - **state the stop rules with their real conditions:** the time limit counts from the start,
     so start time comes out of it, and the plugin's rules apply only while the Harness is
     open. When it is closed, only the Space's own sleep time protects the account.
2. **When the Space is ready,** the session is resumed with one plugin message. It quotes the
   user's waiting message and states that the earlier line came from the plugin.
   - **Why:** without that, a model treated "the last user message" as the plugin's notice,
     answered it, and invented a background job to check.
3. **Everything else** happens in the interface: warnings, progress, cost and controls. That
   covers the time-limit warning, failure and credential problems.
   - **What never happens:** a chat turn opened by the plugin for these, or a background job
     used as a progress bar.

## 9. Interface

| Element | Slot | Content |
|---|---|---|
| Header indicator | `conversation.session.header.utilities` | Shown only when the session's model belongs to a configured Space: the session's own choice, or else the profile default, read from the model-selection service (`modelDirectories`, optional). One short line that fits the narrow header: state dot, name, short state ("starting 42% · ~2 min", "serving · until 13:48"), a small meter while starting, and one action (Start or Stop). The state is a button that opens the sidebar tab; the full line is its tooltip |
| Sidebar tab | `sidebarRightTabs` + `sidebar.right.pane.tab` | "Hugging Face Spaces", also listed on the sidebar's start page. One card per Space: state and buttons, progress bar, time on, stop time, what Hugging Face billed today and this month, the last 5 starts (duration, cost, why each ended), the run-log tail of the last start; then the state of each credential |
| Toasts | `shell.overlay` | Time limit soon with Extend and Stop, start failed, refused effort levels, a missing or refused inference or control credential, and the answer to the last button pressed |
| Setup page | `plugins.bundle.config`, key `dsh-hf-spaces` | Configuration problems, each credential, and per Space: what was read (Space, manifest), whether the models were served, the effort check, and each effective value with its source |

Interface rules:
- **Theme:** semantic theme tokens (`--dsw-alias-*`), with light and dark checked.
- **Accessibility:** keyboard focus and roles kept on every control.
- **Imports:** no internal Harness Client packages imported as a component library.
- **Look:** one scoped style sheet (`dhs-` classes) with the Harness theme tokens only; one color
  per state, always with a word; no motion under prefers-reduced-motion. Checked in a browser
  preview with the tokens extracted from the installed Harness (light and dark, 480 to 980 px).
- **Updates:** only `slots` is required. The sidebar services and the model-selection service
  are waited for with `ctx.inject`, and every slot with `ctx.slots.inject`; `dsh.client.inject`
  lists no new package. A Harness version without one of them only loses that part.

## 10. Lessons from the private prototype

The design comes from a private, single-Space prototype that ran from 2026-10-19 to 2026-10-30
on the Harness 0.2.x line. Lessons, all verified:

1. **Inject optional services.** The prototype read the command registry with a one-time
   `ctx.get('commands')`. On the Desktop the plugin loaded first, so the command never existed,
   with no error. `ctx.inject(['commands'], ...)` fixed it.
2. **Resume by quoting the user.** In 2 of 2 real starts, the model answered the resume notice
   instead of the user. One also called a tool with an invented job id.
3. **Wait for the warm-up.** Waking the session while the server ran its first (warm-up) request
   only queued the session behind it, on a single-slot server. Waiting for the warm-up gives the
   same first-answer time and an honest "ready".
4. **Chat-based UI fails.** Fixed replies, notice turns and a background job used as a progress
   bar were confusing. Command results were invisible in an empty session. Hence section 8.
5. **Every start re-reads the weights,** because the Space disk is wiped. On an A100:
   - copy ~90 s for 22.5 GB;
   - load ~55 s;
   - first request ~35–45 s.
6. **The account balance cannot be read by token.** The plugin shows what was billed instead,
   and no balance (decided with the user on 2026-10-31).
7. **A background job is not a progress display.** The prototype's start task sat behind a
   collapsed "1 background job running" line, and the user did not find the progress. This
   plugin shows it in the header and the sidebar tab only.

## 11. Roadmap

| Phase | Output | Exit criterion |
|---|---|---|
| 0. Contracts | A verified contract note: Client bundle format and what it receives (React, theme, locale), the three slots, `webServer` routes, credential APIs, HF Space endpoints | Each item verified on Harness 0.2.1-rc.3 or marked not available |
| 1. Host | Provider routes, supervisor, HF client, Space manifest reader with the value order of section 6, routes, offline tests (HF and Space simulators), admission test with the installed Harness's own rule | Parity with the prototype except the UI; `npm run check` green; admitted on 0.2.1-rc.3 and refused from `0.3.0-alpha.1` on; the model appears in the selector with its name and only the effort levels the Space accepts (section 6, "Model names and reasoning efforts") |
| 2. Client | Indicator, sidebar tab, toasts, and a setup page that lists each check (credentials, Space, manifest, models, effort levels) and each effective value with its source | Manual test on the Desktop by a maintainer. **Built 2026-10-31**, offline tests of every part; the Desktop check is the user's |
| 3. Migration | Replace the prototype in a real profile, with an explicit `route` equal to the prototype's provider id and its event prefix set in that profile. The prototype's Space gets a manifest, so the profile keeps only the Space id, the route and the credential names | Sessions bound to the old provider id keep working. **Done 2026-10-31:** route `rvn`, prototype removed from the profile; the Space has no manifest yet, so its models stay in the profile (a commit to the Space repository would rebuild it) |
| 4. 1.0 | npm package, compatibility matrix, audit for secrets and personal data, install guide for AI agents, repository made public | Audit clean; `npm run check` green; an AI agent that follows only the install guide sets the plugin up on a clean profile, without asking for a secret in the chat |

## 12. Open questions

- ~~Is the hourly price of each hardware readable from a public Hugging Face endpoint?~~
  Yes, settled in Phase 0: `GET /api/spaces/hardware` ([contracts.md](contracts.md)). A
  configured price is only an override.
- ~~Which effort level does the selector pick by default when the user picks the model?~~
  Settled in Phase 1: the route's `reasoning` field sets the model's `defaultEffort`. The plugin
  sets `medium` when every model of the Space lists it, or the configured `defaultEffort`
  (runtime test, 2026-10-30).
- ~~Does the Harness plugin settings page render the configuration schema with descriptions?~~
  No, settled in Phase 0: a plugin registers its own page ([contracts.md](contracts.md)).
- Should a reference Space template (llama.cpp, bucket volume, `SPACE_EVENT` lines, a
  `dsh-hf-spaces.json` manifest) live in this repository after 1.0?
