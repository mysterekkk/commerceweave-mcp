# Streamable HTTP transport

stdio is the default and the safest way to run CommerceWeave (the client launches it as a child process). Use HTTP only when a client cannot spawn processes, e.g. a container or another machine on your network.

```bash
export COMMERCEWEAVE_HTTP_TOKEN="$(openssl rand -hex 32)"   # required, >= 32 characters
npx commerceweave-mcp serve-http
# [commerceweave] ... listening on http://127.0.0.1:8787/mcp (bearer token required)
```

Connect a client (Claude Code):

```bash
claude mcp add --transport http commerceweave http://127.0.0.1:8787/mcp --header "Authorization: Bearer $COMMERCEWEAVE_HTTP_TOKEN"
```

(That puts the token into your client config; keep that file private.)

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `COMMERCEWEAVE_HTTP_TOKEN` | none, **required** | shared bearer token, min 32 chars. The server refuses to start without it. |
| `COMMERCEWEAVE_HTTP_HOST` | `127.0.0.1` | bind address |
| `COMMERCEWEAVE_HTTP_PORT` | `8787` | port (`0` = random) |
| `COMMERCEWEAVE_HTTP_ALLOW_REMOTE` | `false` | required to bind anything but loopback |
| `COMMERCEWEAVE_HTTP_ALLOWED_HOSTS` | loopback names | Host header names accepted; **required** for non-loopback binds |
| `COMMERCEWEAVE_HTTP_ALLOWED_ORIGINS` | loopback names | Origin hostnames accepted for browser clients |

## Protections

- Every request needs `Authorization: Bearer <token>` (constant-time comparison); otherwise `401`.
- Host and Origin validation (DNS-rebinding protection); other paths than `/mcp` give `404`.
- Wrong credentials are throttled per source address (`429` after 10 per minute). A correct token is never blocked by that, so nobody can lock you out.
- Writes: HTTP clients can propose, but approval is only possible with `commerceweave-mcp approve` in a terminal on the machine that holds `COMMERCEWEAVE_HOME`. There is no approve tool.
- Plain HTTP only. If you expose it beyond loopback, terminate TLS in a reverse proxy; the server logs a warning, because otherwise the token travels in clear text.
- One shared token means one trust level: anyone holding it has the same read and propose rights, over all configured connections.
