# Contributing

```bash
npm ci
npm run check      # lint + typecheck + tests + build
```

- Node.js 22+. TypeScript strict. Tests with Vitest.
- Connector behaviour is tested against local HTTP servers in `tests/helpers/` that mirror the **documented** protocol. When you change a connector, cite the vendor documentation in the PR and update `docs/api-compatibility.md`.
- Never add a tool that calls arbitrary endpoints, deletes data in bulk, or approves its own writes. New write capabilities must go through the proposal flow and come with tests for: read-only mode, missing approval, stale state, single use.
- No real credentials, tokens or customer data in code, fixtures or issues.
- Docs: English first; keep `README.pl.md` in sync for user-facing changes.
- Do not describe features as working unless a test or a documented manual check proves it.
