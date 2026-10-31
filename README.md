# dsh-hf-spaces

Run **open-weight LLMs on your own GPU virtual machine on Hugging Face** (a GPU Space) and use
them inside **DeepSeek Harness** like any other model. The plugin starts the machine when you send
a message, shows the start progress, answers through your own model, and pauses the machine when
you stop using it, so the GPU bills only while it is used.

> **Status: alpha, not released.** Everything planned for the plugin itself is in place and was
> tested on a real private Space on 2026-10-31 (see [Compatibility](#compatibility)). Not
> published on npm yet; see [CHANGELOG.md](CHANGELOG.md). The design is in
> [docs/design.md](docs/design.md).
>
> **Use it responsibly.** You choose and run the models; the plugin adds no content filter. Read
> [Responsible use](#responsible-use) before you install it.

## Contents

1. [What it does](#what-it-does)
2. [The flow, end to end](#the-flow-end-to-end)
3. [Open models, your weights](#open-models-your-weights)
4. [Responsible use](#responsible-use)
5. [Requirements](#requirements)
6. [Installation](#installation)
7. [Credentials](#credentials)
8. [Configuration](#configuration)
9. [Architecture](#architecture)
10. [Security and privacy](#security-and-privacy)
11. [Compatibility](#compatibility)
12. [Roadmap](#roadmap)
13. [Contributing](#contributing)
14. [License](#license)

## What it does

- **Model selector:** each configured Space appears as a provider, with its models, context
  size, output limit and reasoning levels.
- **Start on demand:** sending a message to a paused Space starts it. The conversation resumes by
  itself when the model is ready, answering the message that was waiting.
- **Stop on its own:** after a configurable idle time, and at a per-start time limit with a
  warning a few minutes before and a one-click extension.
- **See what is happening:**
  - **header indicator** in each conversation that uses a Space (also when it is the profile's
    default model): one short line with the state, the percentage and time left while it starts,
    or the stop time while it serves, and one button, Start or Stop. Clicking the state opens the
    sidebar tab;
  - **sidebar tab** "Hugging Face Spaces": the progress bar, what Hugging Face billed for the
    Space today and this month, recent starts (duration, cost, why each one ended), the run-log
    tail of the last start, and the state of each credential;
  - **notices:** time limit soon (with +N and Stop), a failed start, refused effort levels, a
    missing or refused credential;
  - **setup page** in the Plugins panel: every check (credentials, Space, manifest, models,
    effort levels) and every effective value with its source.
- **Manual control:** `/space status | on | off | +N` and the buttons, which never send anything
  to the model.
- **No account balance:** Hugging Face shows the balance only on its billing page while signed in,
  not through the API, so the plugin does not show it. It shows what was billed instead.

## The flow, end to end

A **Hugging Face Space** is a virtual machine that Hugging Face runs for you. On GPU hardware
(for example an A100), it is billed per minute while it starts and runs, and costs nothing while
paused. Your Space runs an OpenAI-compatible server (for example llama.cpp `llama-server`) with
the model weights you choose.

```
 DeepSeek Harness (your computer)                      Hugging Face (your account)
 ┌────────────────────────────────┐                    ┌──────────────────────────────┐
 │ model selector: "My LLM"       │                    │ GPU Space (virtual machine)  │
 │ you send a message ────────────┼── is it serving? ─►│  paused  → started by the    │
 │                                │                    │            plugin (API)      │
 │ header: "starting 42% · ~2 min"│◄── progress ───────┤  booting → copies and loads  │
 │                                │                    │            your weights      │
 │ the answer streams back ◄──────┼── your model ──────┤  serving → OpenAI-compatible │
 │                                │                    │            API (/v1)         │
 │ idle 30 min / limit 60 min ────┼── pause ──────────►│  paused  → billing stops     │
 └────────────────────────────────┘                    └──────────────────────────────┘
```

1. **You pick the Space's model** in the Harness model selector, like any other model.
2. **You send a message.** If the Space serves, the message goes straight to it. If it is paused,
   the plugin answers with one short notice, starts the Space through the Hugging Face API, and
   shows the progress in the conversation header: GPU and container start, weight copy, load,
   warm-up.
3. **When the model is ready,** the conversation resumes by itself and your model answers the
   message that was waiting. The first start of a 27B model on an A100 took about 3 minutes.
4. **While you work,** every request goes from your computer to your Space's own address
   (`https://<subdomain>.hf.space`), with your token. No third-party inference service is
   involved.
5. **When you stop using it,** the plugin pauses the Space: after 30 minutes without requests, at
   the 60-minute limit of each start (extendable), or when you press Stop. Billing stops.
6. **If the Harness is closed,** the plugin cannot pause the Space; only the Space's own sleep
   time does. Set one in the Space settings.

**Private Spaces** keep your weights and your Space private to your account: only a token with
access to the Space can call it. Hugging Face still runs the machine, so its
[Privacy Policy](https://huggingface.co/privacy) applies to what runs there.

## Open models, your weights

- **You bring the model.** The plugin ships no model and downloads none. Your Space serves
  whatever open-weight model you put in it: a base model, an instruction-tuned one, a
  quantization (for example GGUF with llama.cpp), or your own fine-tune.
- **That includes models with fewer built-in refusals,** often called "uncensored" or
  "abliterated". Hosted assistants decline many requests by policy; a model you run yourself
  follows the weights and the system prompt you give it.
- **Each model keeps its own license.** Open weights are not all free for every use: check the
  license and acceptable-use policy of every model you run.
- **The selector shows exactly what you declare:** the model name, its context size and only the
  reasoning-effort levels your server accepts. The plugin checks those levels at the first start
  and reports any the server refuses.

## Responsible use

This plugin is a tool to run models **you** choose on a machine **you** control. It adds no
content filter, and a model with fewer refusals will answer requests that hosted assistants
decline. That freedom comes with responsibility, and it is yours.

**By using this plugin you agree to:**
- comply with the laws that apply to you and to the people your use affects;
- comply with the Hugging Face [Terms of Service](https://huggingface.co/terms-of-service) and
  [Content Policy](https://huggingface.co/content-policy), which govern what runs on its
  machines;
- comply with the license and acceptable-use policy of each model you run.

**Do not use this plugin, or the models you run with it, to:**
- do anything illegal where you live or where its effects reach;
- create, request or share sexual content involving minors, in any form;
- plan, promote or facilitate violence, terrorism, or weapons capable of mass harm (biological,
  chemical, nuclear, radiological, or explosives);
- write malware, or attack, scan or break into systems you are not authorized to test;
- harass, threaten, stalk, defame or impersonate people, or expose their private data;
- run fraud, scams, spam, or deceptive content presented as real (for example deepfakes of real
  people without consent);
- infringe privacy, copyright or other rights of others.

**If other people use your setup,** add your own safeguards: a system prompt that sets limits,
review of what is produced, and restricted access to the Space and its tokens.

**No warranty.** The software is provided "as is" under the [MIT License](LICENSE). Its authors
are not responsible for how it is used, for what the models produce, or for charges on your
Hugging Face account.

## Requirements

- **DeepSeek Harness Desktop:** the 0.2.x line, from 0.2.1-rc.3.
- **A Hugging Face account** with a **GPU Space** that serves an OpenAI-compatible API
  (`GET /v1/models`, `POST /v1/chat/completions`).
- **A Hugging Face access token,** stored in the Harness credential vault (see
  [Credentials](#credentials)).
- **Recommended: the Hugging Face PRO plan (US$ 9/month), plus credits or a card for the GPU.**
  This is what unlocks GPU Spaces and room for the weights. Read on the official pages on
  2026-10-31:
  - **Docker or Gradio Spaces on GPU** "require a paid plan"
    ([spaces-gpus](https://huggingface.co/docs/hub/spaces-gpus)), and PRO lists "the ability to
    create Gradio and Docker Spaces running on compute" ([pro](https://huggingface.co/docs/hub/pro)).
    Whether a card alone is enough is not stated, so plan on PRO.
  - **Storage for the model weights:** PRO raises private storage from 100 GB to 1 TB
    ([pro](https://huggingface.co/docs/hub/pro)). A 27B model and its bucket copy use tens of GB.
  - **Included monthly compute credits**, usable on upgraded Space hardware, are applied before
    pay-as-you-go usage ([billing](https://huggingface.co/docs/hub/billing)); the amount is not
    stated. The pricing page labels the US$ 2 included per month as inference credits, so do not
    count on PRO alone to pay for GPU time.
  - **The GPU itself is billed separately from PRO,** per minute while the Space starts or runs
    (A100 large US$ 2.50/h, L40S US$ 1.80/h on [pricing](https://huggingface.co/pricing)), from
    credits first and then the card ([billing](https://huggingface.co/docs/hub/billing)). Keep a
    prepaid balance or automatic recharge, as Hugging Face recommends, so a start is not refused
    mid-session. Check the balance on the billing page: it is not available to plugins.

## Installation

For people and for AI agents. Each step says what you should see; stop at the first step that
does not match, and fix it before going on.

**AI agents:** never ask for a token in the chat, and never write one to a file yourself. Step 3
is the user's.

1. **Get the package** (needs Node.js 22 or later and Git):
   ```bash
   git clone https://github.com/dev-bravelo/dsh-hf-spaces.git
   cd dsh-hf-spaces
   npm pack
   ```
   You should see a file `dsh-hf-spaces-<version>.tgz` in the folder. There are no dependencies
   to install.

2. **Install it in your Harness profile.** In a Harness session, ask the agent to install the
   bundle from that file with the plugin manager (`plugin_manager` → `install_bundle`, with the
   absolute path of the `.tgz`). You should see `dsh-hf-spaces` listed as installed and enabled.
   - **Stop if** it is listed as `incompatible-version`: your Harness is outside the supported
     range (see [Compatibility](#compatibility)).

3. **Store your Hugging Face token** (the user does this, outside any chat). Create a token at
   https://huggingface.co/settings/tokens with the permissions in [Credentials](#credentials).
   Then put it in the Harness credential vault under the name `HF_TOKEN`, in one of these ways:
   - in `<Harness home>/.credentials.yaml`, under `refs:` (the Harness reloads it by itself):
     ```yaml
     version: 1
     refs:
       HF_TOKEN: <your token>
     ```
   - or as the environment variable `HF_TOKEN` before the Harness starts, or in
     `<Harness home>/.env`.

   `<Harness home>` is `~/.dsh`, or `$DSH_HOME` when set. Keep the file private: it holds keys.

4. **Tell the plugin about your Space.** Add this entry to your profile's patch file,
   `<Harness home>/profiles/<profile>/cordis.patch.yml` (a YAML list; add the entry to it):
   ```yaml
   - id: hf-spaces
     name: dsh-hf-spaces
     config:
       spaces:
         - id: your-user/your-llm-space         # your Space, owner/name
           models:
             - id: your-model-id                # exactly as GET /v1/models lists it
               name: My model 27B               # the name shown in the model selector
               reasoning: { "off": none, low: low, medium: medium, high: high }
   ```
   Every other field has a default; all of them are in
   [examples/config.example.yml](examples/config.example.yml). `models` may be left out when the
   Space publishes a `dsh-hf-spaces.json` manifest ([design, section 6](docs/design.md)).

5. **Restart the Harness and open Plugins → dsh-hf-spaces.** Every check should read "ok":
   credentials accepted, Space read, models listed. "Models served" and "Effort levels" read
   "later" until the first start.
   - **Stop if** a line reads "fix": its message says what to change.

6. **Use it.** Pick your model in the model selector and send a message. The plugin starts the
   Space and shows the progress in the conversation header; the answer comes when the model is
   ready. Press **Stop** in the header, or send `/space off`, when you are done.

**To remove it:** delete the `hf-spaces` entry from the profile patch and uninstall the bundle
with the plugin manager. The Space itself is left as it is: pause it on Hugging Face if it runs.

## Credentials

**The configuration never contains a token.** It only names a credential stored in the
Harness vault, and the default name is `HF_TOKEN`. The sidebar tab and the setup page show
whether each credential is in the vault, whether Hugging Face accepts it, its account and its
token role, never its value.

| Setting | Required | Used for | Token permission on Hugging Face |
|---|---|---|---|
| `credentials.inference` | **Yes** | Sending requests to the model in a private Space | Read access to the Space |
| `credentials.control` | Yes, to start and stop | Starting, pausing and restarting the Space | Write access to the Space |
| `credentials.billing` | No | What Hugging Face billed for each Space today and this month | Read access to billing |

- **One classic token with write access covers all three.**
- **For least privilege,** create separate fine-grained tokens and give each setting its own
  credential name.
- **Create tokens at** https://huggingface.co/settings/tokens.

## Configuration

A complete, commented example is in
[examples/config.example.yml](examples/config.example.yml). The only required field per Space is
its `id` (`owner/space-name`).
- **Derived from the Space:** the API address and the hardware.
- **Read from Hugging Face:** the hourly price.
- **Start variables:** for a Space that needs a fresh value at each boot (a session id, a start
  deadline), declared as data with placeholders.
- **The plugin's records** (recent starts) are kept in `<Harness home>/state/dsh-hf-spaces`
  (`stateDir` changes it).

## Architecture

The plugin has two halves, as DeepSeek Harness expects:

| Half | Runs in | Responsibilities |
|---|---|---|
| Host | The Harness backend (Node.js) | Model route per Space; Space supervisor (state, start, stop, idle and time-limit rules, cost); a small Hugging Face API client; its own records of recent starts; local HTTP routes for the interface, guarded by the Harness |
| Client | The Harness window (web UI) | Header indicator, sidebar tab, notices and setup page; reads state from the Host routes; buttons call Host actions |

The Space side is any Space that serves an **OpenAI-compatible API**, for example llama.cpp
`llama-server`. If the Space also prints the optional progress events described in the design,
the start progress becomes more detailed (copy percentage, load, warm-up).

## Security and privacy

- **Tokens** are never written to configuration, logs, records or the interface. A token pasted
  where a credential name or a start variable is expected is refused, without repeating it.
- **Tokens go only to Hugging Face** (`https://huggingface.co`) and to the Space's own
  `https://*.hf.space` address. Redirects are never followed with a token.
- **Your conversations go only to your Space.** The plugin sends no telemetry and uses no other
  service.
- **Local HTTP routes** check every request with the Harness's own guard
  (`connection.requestRejection`), accept small bodies only, and offer three actions: start, stop
  and extend.
- **Tests never call real services:** they use a simulated Hugging Face API and a simulated
  Space, on 127.0.0.1 only.
- **This repository** has a secret and personal-data scanner, with no dependencies, run by the
  `pre-commit` and `commit-msg` hooks. See [AGENTS.md](AGENTS.md), section 4.

**Reporting a vulnerability:** see [SECURITY.md](SECURITY.md). Never paste a token in an issue.

## Compatibility

| Plugin | DeepSeek Harness | Status |
|---|---|---|
| 0.1.0-alpha.8 (unreleased) | 0.2.1-rc.3 | The full plugin, with the interface redesigned after the first Desktop test (alpha.7): selector, start and resume, progress, /space, stop rules, header indicator, sidebar tab, notices, setup page, billing usage and start records. Offline and runtime tests on the installed Harness, Windows, 2026-10-31. First real start (alpha.7, 2026-10-31, private A100 Space): ready in 3 min 11 s with live progress, stopped by /space off after 18 min, US$ 0.75 estimated. The redesigned header was seen working on the Desktop the same day, in a session switched from another model |

Each release states the Harness versions it was tested on and how it was tested.

**When you update DeepSeek Harness:**
- **Inside the tested range** (`engines.dsh` in `package.json`, today `>=0.2.1-rc.3 <0.3.0-0`),
  the plugin keeps working with no change.
- **Outside it,** the Harness does not load the plugin. The plugin manager shows it as
  `incompatible-version`, and the fix is a newer plugin release, not a workaround.
- **Each part of the interface waits for the Harness service it uses.** If a Harness version
  drops one (for example the right sidebar), only that part is missing; the rest keeps working.

How the plugin is kept compatible is a contributor rule: [AGENTS.md, section 7](AGENTS.md#7-compatibility-with-harness-updates).

## Roadmap

| Phase | Delivers | State |
|---|---|---|
| 0. Contracts | Verify, on the installed Harness, the client plugin format, slots, local routes and credential APIs, and the Hugging Face Space endpoints | Done |
| 1. Host | Model routes and Space supervisor, with offline tests | Done |
| 2. Client | Header indicator, sidebar tab, notices and setup page | Done |
| 3. Migration | Replace the private prototype it grew from | Done in a real profile, 2026-10-31 |
| 4. Release 1.0 | Public repository, npm package, compatibility matrix | Next |

## Contributing

Read [AGENTS.md](AGENTS.md) first. Its rules apply to people and to AI coding agents alike. In
short:
- write in English;
- never commit secrets or personal data;
- keep tests offline;
- run `npm run check` before every commit.

## License

[MIT](LICENSE). See [Responsible use](#responsible-use).
