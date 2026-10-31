# Contracts verified in Phase 0

Status: **Phase 0 record**, written on 2026-10-30. It lists the external interfaces the plugin
depends on, each with its source and verification level, so that Phase 1 code is written
against facts. The architecture that uses them is in [design.md](design.md).

Verification levels:
- **Verified:** observed on a real system on the date shown.
- **Read:** read in source code or official docs, not exercised.
- **Not available:** looked for and not found.

Everything here was checked against:
- Hugging Face Hub API, on 2026-10-30, on a private Docker Space with GPU hardware, while
  paused. Client source: `huggingface_hub` 2.2.0 (`hf_api.py`, `_space_api.py`).
- DeepSeek Harness Desktop **0.2.1-rc.3**, read in the installed package. Only admission was
  run, through the app's own compatibility function.

Only `GET` requests were sent to Hugging Face in Phase 0. Write endpoints were not called.

## Contents

1. [Hugging Face Hub API](#1-hugging-face-hub-api)
2. [DeepSeek Harness plugin APIs](#2-deepseek-harness-plugin-apis)
3. [Consequences for the design](#3-consequences-for-the-design)
4. [Not verified yet](#4-not-verified-yet)

## 1. Hugging Face Hub API

Base URL `https://huggingface.co`. Every call sends `Authorization: Bearer <token>` unless
marked public. `{id}` is the Space id, `owner/name`.

### Read endpoints (verified 2026-10-30)

| Endpoint | Response | Notes |
|---|---|---|
| `GET /api/whoami-v2` | `{type, id, name, fullname, canPay, billingMode, periodEnd, isPro, avatarUrl, orgs, auth}`; `auth.accessToken = {displayName, role, createdAt, fineGrained?}` | `role` is `read`, `write` or `fineGrained`. A fine-grained token lists `fineGrained.global` and `fineGrained.scoped[].permissions` (for example `repo.content.read`, `repo.write`, `user.billing.read`). The client source says its rate limit is "intentionally strict": call it once per credential change, never in a loop |
| `GET /api/spaces/{id}` | Keys include `id`, `sdk`, `private`, `host`, `subdomain`, `region`, `usedStorage`, `runtime` | `host` is the full origin, `https://<subdomain>.hf.space`. `runtime` here also has `volumes` |
| `GET /api/spaces/{id}/runtime` | `{stage, hardware: {current, requested}, gcTimeout, replicas: {requested}, devMode, domains: [{domain, stage}]}` | Paused: `stage` `PAUSED`, `hardware.current` `null`, `requested` keeps the flavor. `gcTimeout` is the sleep time in seconds. No `volumes` and no `storage` key in this response |
| `GET /api/spaces/{id}/variables` | Object keyed by name: `{key, value, updatedAt}` | |
| `GET /api/spaces/{id}/secrets` | Object keyed by name: `{key, description, updatedAt}` | Values are write-only and never returned |
| `GET /api/spaces/hardware` | **Public.** Array of `{name, prettyName, cpu, ram, accelerator, unitCostMicroUSD, unitCostUSD, unitLabel}` | 21 flavors on 2026-10-30. `unitLabel` is `minute`. Examples: `a100-large` 0.041667 (US$ 2.50/h), `l40sx1` 0.03 (US$ 1.80/h), `l4x1` 0.013333 (US$ 0.80/h) |
| `GET /api/settings/billing/usage-v2?startDate=<s>&endDate=<s>` | `{usage: {Spaces, Endpoints, inferenceProviders, jobs, privateStorage, zeroGpu}}` | Dates in Unix seconds. Works with a fine-grained token that has `user.billing.read` |
| `GET /api/spaces/{id}/logs/run` | Server-sent events. Each `data:` line is JSON whose `data` field is one log line. Optional `?tail=<n>` | **While the Space is paused, the server sends no response headers** (see below). While a Space starts or runs, the private prototype read its progress events from this stream on every start |
| `GET https://huggingface.co/spaces/{id}/resolve/{sha}/{file}` | The raw file from the Space repository at revision `sha` | Read on a **paused** private Space in 140 ms (HTTP 200 with the token, 401 without). Nothing starts. `GET /api/spaces/{id}` → `siblings[].rfilename` lists the files first. `cardData` only held the README's display fields (`title`, `emoji`, `colorFrom`, `colorTo`, `sdk`, `app_port`) |
| `GET /api/spaces/{id}/volumes` | **Not available:** HTTP 404 | Read volumes from `GET /api/spaces/{id}` → `runtime.volumes`: `[{type, source, mountPath, readOnly, configuredByUserId}]` |

**The silent run log is provider behavior, not a client error.** Tested on 2026-10-30 on a
paused Space:
- `fetch` with no `Accept` header, with `Accept: text/event-stream`, and on `logs/build`: no
  response headers in 30 s, each time;
- the official client (`HfApi.fetch_space_logs(follow=False)`): 0 lines after 5 s and no error,
  because it treats a read timeout as "no more logs".

So a silent stream means "nothing to read now", and the plugin must abort it on a timeout.
Whether the stream answers in other stopped stages was not tested: the account had no other
Space.

Space stages, from `huggingface_hub` 2.2.0 `SpaceStage`: `NO_APP_FILE`, `CONFIG_ERROR`,
`BUILDING`, `BUILD_ERROR`, `RUNNING`, `RUNNING_BUILDING`, `RUNTIME_ERROR`, `DELETING`, `STOPPED`,
`PAUSED`, `APP_STARTING`, `RUNNING_APP_STARTING`. The private prototype also treated `SLEEPING`
as stopped. That value is not in the official enum, and the prototype's local records (short,
and not a log of every stage) do not show it, so it stays **not verified**. The client source only describes sleeping as a state "in which free Spaces go
after 48h of inactivity", distinct from paused. The plugin treats any unknown stage as "not
serving", and decides readiness by `GET /v1/models` on the Space.

### Write endpoints (read in `huggingface_hub` 2.2.0)

| Endpoint | Body | Returns | Real use |
|---|---|---|---|
| `POST /api/spaces/{id}/pause` | none | Runtime | Used by the private prototype on every stop, through `huggingface_hub`. Its Space also sends it as a plain HTTPS POST to pause itself. Confirmed by `runtime.stage == "PAUSED"` and `runtime.hardware.current == null`. 403 if the token's owner does not own the Space; 400 for a static Space |
| `POST /api/spaces/{id}/restart` | none; `?factory=true` for a factory reboot | Runtime | Used by the prototype to start a paused Space |
| `POST /api/spaces/{id}/hardware` | `{flavor, sleepTimeSeconds?}` | Runtime | Used by the prototype before a restart |
| `POST /api/spaces/{id}/sleeptime` | `{seconds}`; `-1` means never sleep | Runtime | Not used |
| `POST` / `DELETE /api/spaces/{id}/secrets` | `{key, value, description?}` / `{key}` | none | Not used by the plugin |
| `POST` / `DELETE /api/spaces/{id}/variables` | `{key, value, description?}` / `{key}` | `POST` returns all variables | Used by the prototype to pass a start deadline to its Space |
| `PUT` / `DELETE /api/spaces/{id}/volumes` | `{volumes: [{type, source, mountPath, readOnly}]}` | none | Not used |

Runtime errors: the prototype read `errorMessage`, or `compute.status.message`, from the raw
runtime response, and noted that the platform clears it when the Space is paused.

### Token permissions observed

Both a fine-grained token and a classic `write` token returned 200 on every read endpoint above
for a Space owned by the same user. The fine-grained token had, on the user scope:
`repo.content.read`, `repo.write` and `user.billing.read`, among others. Which single permission
each endpoint requires was **not isolated** (see section 4).

## 2. DeepSeek Harness plugin APIs

Read on 2026-10-30 in the installed 0.2.1-rc.3 package (`app.asar`, under
`dsh/node_modules/@deepseek-ai/`). Sources are package READMEs, the official
`cordis-plugin-development` skill shipped in `dsh-agent-preset`, and installed `lib` code.
Nothing in this section was run in Phase 0, so every item is **Read** unless marked otherwise.
"Seen in a community plugin" means a third-party plugin admitted on this version uses it.

### Admission (verified)

- **Who decides:** `dsh-app-boot`, before a plugin's module is imported, at composition
  boundaries (startup, profile recomposition, preset mounting).
- **What counts:** when `package.json` declares `engines.dsh`, that range alone decides and
  `peerDependencies` are ignored. Without it, every peer range on `@deepseek-ai/dsh-*` must
  match. Pre-releases take part in the comparison.
- **A refused bundle** is skipped whole and listed in `skippedBundles`; the plugin manager
  reports `incompatible-version`.
- **Verified on 2026-10-30:** the installed app's own `evaluatePluginCompatibility` (from
  `@deepseek-ai/dsh-app-boot`, runtime 0.2.1-rc.3) was run on this repository's `package.json`
  (`engines.dsh: ">=0.2.1-rc.3 <0.3.0-0"`):
  - admitted: `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.9`;
  - refused, with requirement `engines.dsh`: `0.2.1-rc.2`, `0.3.0-alpha.1`, `0.3.0`.

  Real refusals of another plugin were also seen on the 2026-10-17 and 2026-10-27 updates.
- **Conflicting doc, settled:** the `dsh-package-manifest` README says loaders "do not enforce"
  `engines.dsh`. That package only supplies types. The `dsh-app-boot` README, its code and the
  test above show that admission enforces it. The Loader itself checks nothing at import time.

### Client half: packaging and module format

| Contract | Detail | Source |
|---|---|---|
| Declaration | `package.json` has `dsh.client = {platform: "web", inject?, external?, immediately?}` and an `exports["./client"]` entry. The file name is free. `dsh.client` without `./client` makes the loader throw | `dsh-client-modules/lib/index.js` |
| One row, two halves | One `cordis.patch.yml` row loads the Host half (the `"."` export, ESM, `apply`/`inject`/`Config`/`name`) and the Client half | Official skill templates |
| Two different `inject`s | `dsh.client.inject` only orders which client bundles load first. The exported `inject` lists the services put on `ctx` | Official skill, `practices.md` |
| Module format | Neither ESM nor CJS: a classic script that calls `window.__ModuleLoader__.load({id: "<exact package name>", factory: (require) => ({apply, inject})})`. A wrong `id` fails with "loaded without registering" | `dsh-client-modules` |
| React | Provided by the window. `require` resolves from a fixed table: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod` and a few Harness client packages. Do not bundle React. `external` is only for names outside that table | `dsh-web-frontend` bundle; official skill (`ui-plugin.md`) |
| Build step | Not needed. The official template's `client.js` is plain JavaScript with `React.createElement`. No `import` statements; no relative `require` between client files | Official skill template |
| `apply(ctx)` | The Cordis client context, with injected services (`ctx.slots`, `ctx.locale`, `ctx.theme`, …) and `ctx.effect`, `ctx.on`, `ctx.inject`, `ctx.get` | `dsh-client-modules`, official skill |

### Theme and locale

- **Colors:** `var(--dsw-alias-*)` tokens in CSS (official skill, `practices.md`; seen in a
  community plugin).
- **Dark or light:** `ctx.theme.getTheme().active.colorScheme`, and the `theme/change` event
  (`dsh-client-ui-theme`).
- **Translations:** `ctx.locale.register(namespace, {en, zh, …})` inside `ctx.effect`. A slot
  registered with `locale: namespace` gives its component a `t` prop (`dsh-client-locale`
  README).

### Slots

| Slot | Kind and scope | Notes |
|---|---|---|
| `conversation.session.header.corner` | **single**, session | **Already taken** by the right sidebar's expand button (`dsh-client-ui-sidebar-right`). Not usable |
| `conversation.session.header.actions` and `.utilities` | list, session | Where the header indicator goes. Components on `.actions` receive `sessionId`, `useSession`, `useSessions`, `useSessionStatus` and `t` (seen in the official agent-team client) |
| `sidebar.right.pane.tab` | keyed, session | The tab is declared with `ctx.sidebarRightTabs.register({id, kind, title, …})`, which returns a disposer. The body registers under `key: id` and reads `{sidebar, panel, tab}` from `props.useTabInfo()`. `ctx.sidebarRight.openTab(kind)` opens it (`dsh-client-ui-sidebar-right` README; seen in a community plugin) |
| `shell.overlay` | list, root | Rendered with empty props (`dsh-client-ui-layout`). There is **no public toast API**: the plugin draws its own toasts here |
| `plugins.bundle.config` / `plugins.row.config` | keyed by package name / by `<package>#<row id>` | The plugin's own settings page (see below) |

**Model of the current session:** inside a session-scoped component,
`useSessions(s => s.projectionsBySession[sessionId]?.values.modelSelection?.next)` returns
`{provider, model, reasoningEffort?}`. `undefined` means the catalog default
(`dsh-client-ui-model-selection`; official agent-team client).

### Model selector

| Contract | Detail | Source |
|---|---|---|
| Provider route | A `dsh-llm-pi-ai` route declares `displayName` (the label the selector shows), `api`, `baseURL`, `apiKeyEnv` and `models`. A hand-declared route id is a lowercase hyphenated identifier | `dsh-llm-pi-ai` README |
| Model entry | `models[]` has `id`, `name`, `contextWindow`, `maxTokens` and `reasoningEfforts`. A `models` list replaces the route's catalog | Same |
| Effort levels | `reasoningEfforts` maps each level the selector offers to the value sent on the wire (`max: ultra` renames a level). `false` declares a model without reasoning. Exact-model metadata lists the levels from least to greatest | Same |
| What the selector shows | Models grouped by provider, by catalog name. The selected model decides which effort names exist and the default. Only levels the adapter advertises are offered: no free input, and no Effort row without reasoning metadata | `dsh-client-ui-model-selection` README |
| Refresh | Each session's model list loads again on `llm/adapters-updated`, `settings/document-updated` and credential events | Same |
| Model discovery | For a route the installed catalog does not describe, pi-ai can list `GET {baseURL}/models`. The reply is only a suggestion for a settings page; the configuration decides what the route serves | `dsh-llm-pi-ai` README |
| Name decoration | `conversation.input.model.label` is a single slot, already used by an official package | Code; not used by this plugin |

**Verified on 2026-10-30, Desktop 0.2.1-rc.3, with the private prototype:** a route built the
same way showed the model name and the effort "Medium" in the composer.

**Default effort, verified on 2026-10-30 by this plugin's runtime test:** the route's `reasoning`
field (pi-ai) becomes the model's `reasoning.defaultEffort`. `ctx.llm.listModels(route)` and
`ctx.llm.resolveModelInfo(route, model)` return what the selector shows: name, ordered effort
ids, default effort and context window.

**Registering routes from a plugin.** The plugin mounts one `dsh-llm-pi-ai` instance per Space. pi-ai
also publishes three process-wide registries (configurable-provider directory, model discovery,
sign-in flows) that the profile's main instance owns, and a second copy collides ("configurable
provider ... is already declared"). Its instances therefore see no-op versions of
`registerConfigurableProviders`, `registerModelDiscovery` and `authorization.registerFlow`.
- **Evidence:** used by the private prototype since 2026-10-19 on 0.2.1-rc.2 and rc.3. This
  plugin's runtime test shows routes registered, listed and removed on dispose.
- **Risk:** these three names are internal to pi-ai. A Harness update that renames them breaks
  registration, and the runtime test catches it (AGENTS.md, section 7).

**Verified on 2026-09-21, on the prototype's Space:** its llama.cpp Qwen chat template answered
HTTP 500 to the efforts `minimal`, `high` and `max`, and accepted `none`, `low`, `medium` and
`xhigh`. Unsupported levels are rejected visibly, not ignored, so the plugin can check them.

### Settings page

- **The Harness does not draw a page from `Config`.** The `dsh-settings` README says
  `autoGenerate` is for clients that build pages from the schema, and "no shipped client does so
  yet". Its forms only show fields declared `.volatile()`.
- **A plugin shows its own page** in the Plugins panel by registering on `plugins.bundle.config`
  or `plugins.row.config`. The page receives `view: 'page' | 'summary'`, plus `form.state` and
  `form.mutate(ops, rev)` when there are editable fields (`dsh-client-ui-plugin-manager`
  README).

### Host to Client data, and Client buttons

| Contract | Detail | Source |
|---|---|---|
| Plugin HTTP routes | `ctx.webServer.register({kind: 'exact' \| 'prefix', path, handler(req, res)})` with Node `IncomingMessage`/`ServerResponse`. Returns a disposer (wrap it in `ctx.effect`). A duplicate path throws | `dsh-host-webserver` |
| The Harness fence | Its own `/api` routes check Host and Origin (403) and then a signed `HttpOnly`, `SameSite=Strict` cookie (401) | `dsh-client-connection` README |
| Routes outside `/api` | **Get no fence.** The official pattern is `ctx.connection.requestRejection(req)` with `inject: ["webServer", "connection"]` | Code of `dsh-host-open-in-app`; no README section for third parties |
| Authenticated alternative | `ctx.connection.fetch.register({path: '/api/<segment>', methods, requestBody: 'buffered', fetch: req => Response})`: exact path, owner only | Code of `dsh-client-connection` and `dsh-session-log-export` |
| Desktop transport | Non-static `dsh-app://app/*` requests are forwarded to the Host on `127.0.0.1` with the auth cookie added; the scheme streams | Desktop main process code |
| Session projections | `ctx.sessionProjections.register({key, …, wire: {viewSchema, view}})` folds committed session-log events only | Official skill |
| Client button → Host | A JSON `fetch` POST to the plugin's own route (document-relative URL). Session commands also work (`ctx.remote.commands.execute`), but they write to the session log and need a session | `dsh-host-open-in-app` client; official skill (`user-actions.md`) |

**Recommended for live Space state:** the plugin's own route, guarded by
`ctx.connection.requestRejection`, streaming server-sent events that the Client reads with
`fetch` and a stream reader. The official HMR client reads its stream the same way. Projections
do not fit: Space state does not come from the session log.

## 3. Consequences for the design

- **Price per hour:** read from the public `GET /api/spaces/hardware` (`unitCostUSD` × 60). A
  configured price is only an override. This answers the first open question in the design.
- **Base URL:** `GET /api/spaces/{id}` → `host` + `/v1`. Confirmed: `host` is already an
  `https://…hf.space` origin.
- **Stopped check:** stage `PAUSED` or `STOPPED` with `hardware.current == null`.
- **Run log:** open `logs/run` only while starting or running, with an abort timeout, and treat
  a silent stream as "no events yet", not as a failure.
- **Credential check:** one `whoami-v2` call when a credential is set or changes, to show its
  role and whether the needed permissions are present. Never polled.
- **Weight volumes:** a bucket mounted read-only is visible in `runtime.volumes` from
  `GET /api/spaces/{id}`, which lets the interface say where the weights come from.
- **Header indicator:** on `conversation.session.header.actions`, not on `.corner`, which is a
  single slot that the right sidebar already uses.
- **Toasts:** drawn by the plugin in `shell.overlay`, because there is no toast API.
- **Settings:** the Harness shows no page for `Config`. The plugin registers a page on
  `plugins.bundle.config`. Until Phase 2 builds one, settings are edited in the profile's
  configuration file, so field descriptions live in the README and the example file.
- **Client:** one plain-JavaScript file, no build step, React from the window.
- **Routes:** every plugin route is guarded with `ctx.connection.requestRejection`; none is left
  open just because it is on loopback.

## 4. Not verified yet

Each open item says whose limit it is and what would settle it.

| Item | Whose limit | What settles it |
|---|---|---|
| Which fine-grained permission each Space endpoint requires | Ours: only two tokens were at hand, both with broad permissions | A token with only `repo.content.read`, then one with `repo.write` added, created by the account owner for the test |
| `pause`, `restart` and `hardware` sent from Node.js `fetch` | Ours: not exercised (the prototype sent them from Python) | Phase 1 offline tests, then one real start and stop |
| `logs/run` in a stopped stage other than `PAUSED` | Ours: no such Space in the test account | A free CPU Space left to sleep |
| The `SLEEPING` stage name | Provider: not in the official enum | Observing a sleeping Space's runtime |
| Run-log lines while a Space starts, read from Node.js | Ours: read so far only by the Python prototype | One real start in Phase 1 |
| Every Harness item in section 2 except admission | Ours: read, not run | Runtime tests and a manual check on the Desktop in Phase 2 |
| `ctx.connection.requestRejection` and `connection.fetch` for third-party plugins | Provider: in code, with no README section for third parties | A runtime test; prefer them only while the code keeps them |
| Effective provider when `modelSelection.next` is `undefined` | Ours: not found yet | Reading the model catalog client, or a runtime test |
| A second registrant on a single slot | Ours: not tested | Avoided by design: the plugin uses list and keyed slots only |
| `EventSource` over the `dsh-app://` scheme | Ours: not tested | Not needed: the Client reads the stream with `fetch` |
| `dsh.client.immediately` | Provider: set in the official template, not documented | Leave it as the template sets it |
| Whether every chat template rejects an unknown effort (HTTP 500), or some ignore it | Ours: seen on one llama.cpp Qwen template only | The effort check of each new Space, in Phase 1 |

Settled in Phase 0 as provider behavior:
- `GET /api/spaces/{id}/volumes` does not exist; volumes are in `GET /api/spaces/{id}`.
- `logs/run` stays silent while the Space is paused; the official client behaves the same.
- The account balance is not readable by token (see design, section 2).
- The Harness has no toast API and draws no settings page from `Config`.
- `conversation.session.header.corner` is a single slot already used by the Harness.
