# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client says the server failed to start | Node < 22 | `node --version`; install Node 22+ |
| No platform tools, only `commerce_*` | no connection configured, or `COMMERCEWEAVE_DEMO=true` (demo has no platform tools) | run `commerceweave-mcp check` |
| `CONFIG_INVALID … clientId` | `ALLEGRO_ENABLED=true` without credentials | set the variables, see `docs/setup.md` |
| `AUTH_FAILED … not authorized yet` (Allegro) | no token stored | `commerceweave-mcp setup allegro` |
| `AUTH_FAILED … refresh failed` | refresh token expired/revoked | run `setup allegro` again |
| `CONFIG_INVALID … encrypted` | tokens were saved with `COMMERCEWEAVE_TOKEN_KEY` | set the same key |
| `RATE_LIMITED` (Base) | 100 req/min limit; token may be blocked temporarily | wait, request smaller scopes |
| `AMBIGUOUS_TARGET` | variable Woo product without `variantId`, or several Base catalogs/warehouses/price groups | pass the ids named in the message |
| `STALE_PROPOSAL` | live value changed after the proposal | create a new proposal and approve it again |
| `APPROVAL_REQUIRED` | nobody approved | run `commerceweave-mcp approve <id>` in a terminal |
| `WRITE_OUTCOME_UNKNOWN` | timeout/5xx during a write | check the platform value first; do not blindly repeat |
| `complete: false` in a result | a connection failed or the list was truncated | read `errors` / `warnings`; narrow the period |
| Sales total looks too high | potential duplicates are included | read `potentialDuplicates`; map Base statuses with `statusMap` |
| Garbage on the client side / handshake errors | something wrote to stdout | the server never does; check wrapper scripts that echo to stdout |

Logs go to stderr (`COMMERCEWEAVE_LOG_LEVEL=debug`). They never contain credentials.
