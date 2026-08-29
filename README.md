# Sagaz

> **Your agents can act. Can they undo?**

Sagaz is an open source MCP proxy that records every effect your agents produce in the world (the *effect ledger*), classifies each one by reversibility (**R**eversible / **C**ompensable / **I**rreversible), and gives you preview, checkpoint, rollback by compensation, and a kill switch.

One undo for everything your agent touched — including what no snapshot can reach.

![Sagaz demo — coming soon](docs/demo.gif)

## Status

Pre-alpha. Phase 0 (pass-through proxy + persistent ledger + read-only CLI) is under construction. See [`SPEC.md`](SPEC.md) for the vision, architecture, and roadmap.

## Development

Requires Node ≥ 20 and pnpm (the exact version is pinned in `package.json` → `packageManager`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build
pnpm test
node packages/cli/dist/index.js --version
node packages/toybox/dist/index.js seed && node packages/toybox/dist/index.js inspect
```

## Running Sagaz in front of your MCP servers

Sagaz is an MCP proxy: your client talks to `sagaz serve`, Sagaz talks to your servers. Declare the downstream servers in `sagaz.config.json` (same shape as an MCP client's `mcpServers` entries) and point your client at Sagaz:

`sagaz.config.json`:
```json
{ "servers": { "toybox": { "command": "node", "args": ["packages/toybox/dist/index.js"], "env": { "TOYBOX_DB": "./toybox.db" } } } }
```
`.mcp.json` (Claude Code):
```json
{ "mcpServers": { "sagaz": { "command": "node", "args": ["packages/cli/dist/index.js", "serve", "--config", "sagaz.config.json"] } } }
```

Tool names pass through unchanged, whatever the number of servers. If two servers expose the same tool name, Sagaz refuses to start and tells you to add an explicit `"prefix": "name"` to one of them (`name__tool`). Prefixes are never applied automatically.

Phase 0 scope: `tools/list`, `tools/call` and `tools/list_changed` are forwarded. `initialize` is answered by Sagaz itself (it cannot be forwarded verbatim with N downstreams); downstream `instructions` are concatenated and passed on. Resources and prompts are not proxied yet and are not announced in capabilities.

The repo ships a `.mcp.json` and a `sagaz.config.json` wired this way, so Claude Code opened in this directory drives the [toybox](packages/toybox/README.md) world through Sagaz.

## License

MIT
