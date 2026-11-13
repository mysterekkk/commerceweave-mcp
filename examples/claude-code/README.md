# Claude Code

Demo, from a clone of this repository (no credentials needed):

```bash
npm ci && npm run build
claude mcp add commerceweave-demo -e COMMERCEWEAVE_DEMO=true -- node /absolute/path/to/commerceweave-mcp/dist/index.js
```

After the package is published to npm:

```bash
claude mcp add commerceweave -- npx -y commerceweave-mcp
```

Real stores: do not put secrets on the command line (they end up in shell history). Put them in a
config file or in environment variables set outside the command, then reference them:

```bash
# secrets live in your shell profile / secret manager, not in this command
claude mcp add commerceweave -e COMMERCEWEAVE_CONFIG=$HOME/.commerceweave/config.json -- npx -y commerceweave-mcp
```

`config.json` can reference environment variables with `"env:NAME"`, see `../config.example.json`.
