# dsh-hf-spaces

Use your own LLM, served from a GPU **Hugging Face Space**, inside **DeepSeek Harness**:
started on demand, stopped when idle, with live progress, cost and balance shown in the
Harness interface.

> **Status: pre-alpha, design phase.** There is no working plugin code in this repository yet.
> Do not install it. The design is in [docs/design.md](docs/design.md); progress is tracked in
> [CHANGELOG.md](CHANGELOG.md).

## Contents

1. [What it does](#what-it-does)
2. [Why](#why)
3. [How it works](#how-it-works)
4. [Requirements](#requirements)
5. [Credentials](#credentials)
6. [Configuration](#configuration)
7. [Security](#security)
8. [Compatibility](#compatibility)
9. [Roadmap](#roadmap)
10. [Contributing](#contributing)
11. [License](#license)

## What it does

Planned for 1.0:

- **Model selector:** each configured Space appears as a provider, with its models, context
  size, output limit and reasoning levels.
- **Start on demand:** sending a message to a stopped Space starts it. The session resumes by
  itself when the model is ready, answering the message that was waiting.
- **Stop on its own:** after a configurable idle time, and at a per-start time limit with a
  warning a few minutes before and a one-click extension.
- **See what is happening:** a status indicator in the conversation header and a sidebar tab
  with start progress (stage, percentage, time left), time on, estimated cost of the current
  start, today's and this month's billing, and an estimated account balance with a low-balance
  warning.
- **Manual control:** buttons to start, stop and extend, which never send anything to the model.

## Why

A GPU Space is billed by the minute while it starts and runs. Doing it by hand means:
- starting it before you need it;
- remembering to stop it;
- wondering why the first message fails while it boots.

This plugin makes a Space behave like a model that is always available, while it only bills
when it is actually used.

## How it works

The plugin has two halves, as DeepSeek Harness expects:

| Half | Runs in | Responsibilities |
|---|---|---|
| Host | The Harness backend (Node.js) | Model route per Space; Space supervisor (state, start, stop, idle and time-limit rules, cost, balance estimate); a small Hugging Face API client; local-only HTTP routes for the interface |
| Client | The Harness window (web UI) | Header indicator, sidebar tab, toasts; reads state from the Host routes; buttons call Host actions |

The Space side is any Space that serves an **OpenAI-compatible API**, for example llama.cpp
`llama-server`. If the Space also prints the optional progress events described in the design,
the start progress becomes more detailed (copy percentage, load, warm-up).

## Requirements

- **DeepSeek Harness Desktop:** the 0.2.x line. The first target is 0.2.1-rc.3.
- **A Hugging Face account** with a **GPU Space** that serves an OpenAI-compatible API.
- **A Hugging Face access token**, stored in the Harness credential vault (see below).

## Credentials

**The configuration never contains a token.** It only names a credential stored in the
Harness vault, and the default name is `HF_TOKEN`. The interface shows whether each credential is
set and where it comes from, never its value.

| Setting | Required | Used for | Token permission on Hugging Face |
|---|---|---|---|
| `credentials.inference` | **Yes** | Sending requests to the model in a private Space | Read access to the Space |
| `credentials.control` | Yes, to start and stop | Starting, pausing and restarting the Space | Write access to the Space |
| `credentials.billing` | No | Cost today and this month, balance estimate | Read access to billing |

- **One classic token with write access covers all three.**
- **For least privilege,** create separate fine-grained tokens and give each setting its own
  credential name.
- **Create tokens at** https://huggingface.co/settings/tokens.

## Configuration

A complete, commented example is in
[examples/config.example.yml](examples/config.example.yml). The only required field per Space is
its `id` (`owner/space-name`).
- **Derived from the Space:** the API address and the hardware.
- **Read from Hugging Face:** the hourly price, where available.

## Security

- **Tokens are never** written to configuration, logs, events or the interface.
- **The local HTTP routes** answer only loopback requests from the Harness window, with the
  same checks the Harness applies to its own routes.
- **No calls to real services in tests:** they use a simulated Hugging Face API and a
  simulated Space.
- **Reporting a vulnerability:** see [SECURITY.md](SECURITY.md). Never paste a token in an issue.

## Compatibility

| Plugin | DeepSeek Harness | Status |
|---|---|---|
| unreleased | 0.2.1-rc.3 | Design only |

Each release will state the Harness versions it was tested on and how it was tested.

## Roadmap

| Phase | Delivers |
|---|---|
| 0. Contracts | Verify, on the installed Harness, the client plugin format, slots, local routes and credential APIs, and the Hugging Face Space endpoints |
| 1. Host | Model routes and Space supervisor, with offline tests |
| 2. Client | Header indicator, sidebar tab and toasts |
| 3. Migration | Replace the private prototype it grew from |
| 4. Release 1.0 | Public npm package, compatibility matrix |

## Contributing

Read [AGENTS.md](AGENTS.md) first. Its rules apply to people and to AI coding agents alike. In
short:
- write in English;
- never commit secrets or personal data;
- keep tests offline;
- run `npm run check` before every commit.

## License

[MIT](LICENSE).
