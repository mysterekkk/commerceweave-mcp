# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Do not open public issues for security problems. There is no SLA; this is a volunteer-maintained project, reports are handled on a best-effort basis.

## Scope and design

The safety model, threat model and its known limits are documented in [docs/safety.md](docs/safety.md). Highlights:

- read-only by default; writes need an explicit mode and a human approval from a terminal;
- no generic API proxy, no bulk delete, no tool that can approve;
- secrets only via environment/config references, masked in logs and output;
- OAuth tokens: plaintext 0600 file unless `COMMERCEWEAVE_TOKEN_KEY` is set (then AES-256-GCM).

Known limitation: if an agent has unrestricted shell or file access as your user, it can bypass the terminal approval (it could read the approval key). Do not give such an agent access to the account that runs this server.

## Supported versions

Only the latest release receives fixes.
