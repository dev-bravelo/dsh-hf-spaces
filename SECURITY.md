# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on
this repository. Do not open a public issue for a security problem.

**Never include a real token,** API key or credential file in a report, issue, pull request,
log or screenshot. If you think a token was exposed anywhere:
1. revoke it at once at https://huggingface.co/settings/tokens;
2. create a new one;
3. store it again in the Harness credential vault.

## How the plugin will handle credentials (planned for 1.0, not implemented yet)

There is no plugin code yet. These are design requirements, to be implemented and tested before
1.0, not guarantees:
- **In configuration:** credentials are referenced by name (for example `HF_TOKEN`) and read
  from the DeepSeek Harness credential vault only when a request needs them.
- **Where values never go:** configuration, logs, session events, local HTTP routes or the
  interface.
- **Where tokens are sent:** only to Hugging Face hosts over HTTPS. Plain HTTP is accepted only
  for `localhost`, for offline tests.
- **Local routes:** they answer only loopback requests from the Harness window.

## Supported versions

Pre-alpha: there is no supported release yet.
