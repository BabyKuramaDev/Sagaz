# Sagaz

> **Your agents can act. Can they undo?**

Sagaz is an open source MCP proxy that records every effect your agents produce in the world (the *effect ledger*), classifies each one by reversibility (**R**eversible / **C**ompensable / **I**rreversible), and gives you preview, checkpoint, rollback by compensation, and a kill switch.

One undo for everything your agent touched — including what no snapshot can reach.

![Sagaz demo — coming soon](docs/demo.gif)

## Status

Pre-alpha. **Phase 0 is complete**: a transparent stdio MCP proxy, a hash-chained effect ledger, and a read-only CLI to inspect it. No classification or rollback yet — that is Phase 1 and 2. See [`SPEC.md`](SPEC.md) for the vision, architecture, and roadmap.

## Reading the ledger

```sh
sagaz ledger                     # effects of the last session: seq, tool, server, class, status, duration, result size
sagaz ledger --tool send_email   # filters: --session <id|last>, --tool <name>, --status <ok|error|pending|…>
sagaz ledger --json              # one raw row per line (NDJSON)
sagaz status                     # sessions, ledger location, overall state
sagaz verify                     # walk the hash chain of a session and report OK or the first break
```

```
$ sagaz ledger
session 01M17V7N9X4J7KQ84GK07E5JF5  (2026-08-29 22:46:20Z, claude-code 2.1.0)
seq  tool            server  class  status  duration  result  id
───  ──────────────  ──────  ─────  ──────  ────────  ──────  ────────
  1  list_accounts   toybox  read   ok           2ms    345B  EMX4HJV7
  2  create_contact  toybox  -      ok           2ms    198B  YFAYMAT9
  3  send_email      toybox  -      ok           1ms    250B  QKC1D5M5
  4  transfer_funds  toybox  -      ok           1ms    240B  K39GJHH5
  5  transfer_funds  toybox  -      error       11ms    130B  J0R67NJN

$ sagaz verify
verify session 01M17V7N9X4J7KQ84GK07E5JF5
  genesis  2a738bbbf595f48623169551599214e803eb1c601c210fca7ee5d51f6f9502cf
  ✓ seq   1  list_accounts   2a738bbbf595 → 7a0c17c6c46f
  ✓ seq   2  create_contact  7a0c17c6c46f → be9093fa7542
  …
OK 5 effect(s) chained
```

Colour is used only on a TTY and honours [`NO_COLOR`](https://no-color.org).

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

Every `tools/call` that crosses Sagaz is recorded in the **effect ledger**, a local SQLite file (`ledger.path`, default `./.sagaz/ledger.db`, relative to the config file). Each session (one per client `initialize`) has its own hash chain; every closed effect is `sha256(prev_hash || canonical_fields)`, so the ledger is tamper-evident. Large results are truncated to `ledger.maxResultBytes` (default 64 KB) and marked as such. The ledger holds tool arguments and results verbatim — it may contain secrets; it never leaves your machine.

```json
{ "servers": { "...": {} }, "ledger": { "path": "./.sagaz/ledger.db", "maxResultBytes": 65536 } }
```

Tool names pass through unchanged, whatever the number of servers. If two servers expose the same tool name, Sagaz refuses to start and tells you to add an explicit `"prefix": "name"` to one of them (`name__tool`). Prefixes are never applied automatically.

Phase 0 scope: `tools/list`, `tools/call` and `tools/list_changed` are forwarded. `initialize` is answered by Sagaz itself (it cannot be forwarded verbatim with N downstreams); downstream `instructions` are concatenated and passed on (known pending: label each block with its server name once multi-server setups are common). Resources and prompts are not proxied yet and are not announced in capabilities.

The repo ships a `.mcp.json` and a `sagaz.config.json` wired this way, so Claude Code opened in this directory drives the [toybox](packages/toybox/README.md) world through Sagaz.

## License

MIT
