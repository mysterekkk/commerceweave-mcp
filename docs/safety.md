# Safety model

## Modes

| `COMMERCEWEAVE_MODE` | Tools registered | What can happen to your stores |
|---|---|---|
| `read_only` (default) | read tools only | nothing is ever written |
| `proposal` | read + `commerce_prepare_*` + `commerce_get_proposal` | nothing is written; plans are saved locally for review |
| `approval_required` | all of the above + `commerce_execute_proposal` | a plan runs only after a human approved that exact plan |

A connection can additionally be pinned read-only (`"access": "read_only"` in the config file, `*_ACCESS=read_only` in env).

There is **no** generic "call any endpoint" tool, no bulk delete, no tool that creates or deletes products/orders, and no tool that approves anything.

## The approval flow

1. `commerce_prepare_*` reads the **live** value, validates the target (explicit `connectionId`; variable products need `variantId`; Base needs catalog/warehouse/price group when several exist) and stores a proposal: id `cw_…`, before/after, warnings, expiry (default 15 min, `COMMERCEWEAVE_APPROVAL_TTL_MIN`, max 240).
2. The proposal has a `planHash` (SHA-256 of connection + operations + before values + expected after values).
3. A human runs `commerceweave-mcp approve cw_…` in an **interactive terminal**. The CLI prints the plan and asks the human to type a code derived from the plan hash. It refuses to run without a TTY. On success it writes an approval record authenticated with HMAC-SHA256 using a local key (`approval.key`, mode 0600).
4. `commerce_execute_proposal` verifies: mode, status `pending`, not expired, approval record authentic, record bound to this exact plan hash, then **atomically claims** the approval (rename) so concurrent calls cannot both run, and marks the proposal `executing` before any network call.
5. It re-reads the live state; if anything differs from the proposal it aborts without writing (`STALE_PROPOSAL`; the approval is spent).
6. Writes are sequential, never retried automatically, stop at the first failure. After each write the value is read back and compared. Result and audit entries (`audit.log`, no secrets, no personal data) are stored.

### Threat model and limits (read this)

- The trust boundary is "the model cannot press keys in your terminal and cannot read your `COMMERCEWEAVE_HOME`". If you give the agent an unrestricted shell or file access as your user, it can run the `approve` command logic or read `approval.key`. Run the MCP server for an agent that has **no** shell/file tools for that account, or point `COMMERCEWEAVE_HOME` to a directory the agent cannot read.
- The approval proves a human saw the plan; it does not prove the plan is wise. Read the before/after.
- Execution verification reads back through the same API; it cannot detect a platform that silently reverts a value later.
- A timeout during a write yields `WRITE_OUTCOME_UNKNOWN`. Check the platform before creating a new proposal.

## Untrusted data and prompt injection

Product descriptions, buyer notes and other free text are returned under `untrustedText` and every such response carries a `securityNotice`. The server never interprets that text; it cannot change mode, targets or approvals because none of those decisions read platform data.

## Privacy

Orders are returned with masked name/e-mail/phone/login/buyer note unless the call passes `includePersonalData=true`. The server stores no customer data on disk (proposals contain product ids and prices only). You remain the data controller for anything you pass to a model provider; review your provider's terms and GDPR obligations. Redaction is best effort: product names, order item names and platform status text are not scrubbed.

## Secrets

- Passed by environment variables or `env:NAME` references in the config file; never in URLs (Woo uses the `Authorization` header, Base `X-BLToken`).
- All known credential values are masked in logs, errors and tool output. Parser errors for the config file never echo file contents.
- Allegro OAuth tokens live under `COMMERCEWEAVE_HOME/tokens/` (`~/.commerceweave` by default). With `COMMERCEWEAVE_TOKEN_KEY` they are encrypted with AES-256-GCM (scrypt-derived key). **Without it they are plaintext JSON with 0600 permissions** (best effort on Windows); `commerceweave-mcp check` says which mode is active.

## Network

- WooCommerce: HTTPS required; private, loopback, link-local, CGNAT and reserved addresses are refused, DNS is re-resolved before each request. Redirects are refused. `allowInsecure` exists only for local development stores. Residual risk: a DNS rebinding race between the check and the connection (the config is operator-controlled, not model-controlled).
- Platform ids are restricted to `[A-Za-z0-9_-]` and path traversal segments are rejected before any URL is built.
