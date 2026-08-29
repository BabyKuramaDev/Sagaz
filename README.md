# Sagaz

> **Your agents can act. Can they undo?**

Sagaz is an open source MCP proxy that records every effect your agents produce in the world — the *effect ledger*. It is being built to classify each effect by reversibility (**R**eversible / **C**ompensable / **I**rreversible) before it happens, and to give you preview, checkpoint, rollback by compensation, and a kill switch on top of that record.

The goal: one undo for everything your agent touched — including what no snapshot can reach.

## Status

Pre-alpha, not on npm yet. **Phase 0 is complete**: a transparent stdio MCP proxy, a hash-chained effect ledger, and a read-only CLI to inspect it. Today Sagaz *observes*: it does not classify (the `class` column below is empty except for annotated reads) and it does not undo anything — that is Phase 1 and 2. See [`SPEC.md`](SPEC.md) for the vision, architecture and roadmap (in Spanish, as is [`docs/T0-recon-y-schema.md`](docs/T0-recon-y-schema.md), the ledger design and its frozen schema).

## Quickstart

From clone to a populated ledger, with the bundled [toybox](packages/toybox/README.md) — a deliberately dangerous MCP server simulating a CRM, email, tweets and a bank — as the downstream server. Requires Node ≥ 20 and pnpm (`corepack enable` picks the pinned version up).

```sh
git clone https://github.com/BabyKuramaDev/Sagaz.git && cd Sagaz
pnpm install && pnpm build
node packages/toybox/dist/index.js seed        # deterministic sample world in ./toybox.db
claude                                          # Claude Code: the repo's .mcp.json routes toybox through Sagaz
```

Ask the agent for anything — *"list the CRM contacts and send Ada a welcome email"* — then:

```sh
node packages/cli/dist/index.js ledger          # every tools/call that crossed the proxy
node packages/cli/dist/index.js verify          # walk the hash chain
node packages/toybox/dist/index.js inspect      # what the world looks like now
```

To have `sagaz` on your PATH while developing: `pnpm --filter sagaz-mcp link --global`. When published, the CLI will be `npx sagaz-mcp` (the bare `sagaz` name on npm is an unrelated package).

## Reading the ledger

```sh
sagaz ledger                     # effects of the last session: seq, tool, server, class, status, duration, result size
sagaz ledger --tool send_email   # filters: --session <id|last>, --tool <name>, --status <ok|error|pending|…>
sagaz ledger --json              # one raw row per line (NDJSON)
sagaz status                     # sessions, ledger location, overall state
sagaz verify                     # walk the hash chain of a session and report OK or the first break
```

Real output from a Claude Code session, unedited:

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

```sh
pnpm install && pnpm build && pnpm test
node packages/cli/dist/index.js --version
```

Packages: [`@sagaz/core`](packages/core) (proxy + ledger), [`sagaz-mcp`](packages/cli) (the `sagaz` CLI), [`@sagaz/toybox`](packages/toybox).

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

Paths: `ledger.path` and each server's `cwd` are resolved relative to the config file; `command`/`args` are passed to the child process as written, so relative paths in them are relative to wherever Sagaz is started (the example above assumes the repo root).

Every `tools/call` that crosses Sagaz is recorded in the **effect ledger**, a local SQLite file (`ledger.path`, default `./.sagaz/ledger.db`, relative to the config file). Each session (one per client `initialize`) has its own hash chain; every closed effect is `sha256(prev_hash || canonical_fields)`, so the ledger is tamper-evident. Large results are truncated to `ledger.maxResultBytes` (default 64 KB) and marked as such. The ledger holds tool arguments and results verbatim — it may contain secrets; it never leaves your machine.

```json
{ "servers": { "...": {} }, "ledger": { "path": "./.sagaz/ledger.db", "maxResultBytes": 65536 } }
```

Tool names pass through unchanged, whatever the number of servers. If two servers expose the same tool name, Sagaz refuses to start and tells you to add an explicit `"prefix": "name"` to one of them (`name__tool`). Prefixes are never applied automatically.

Phase 0 scope: `tools/list`, `tools/call` and `tools/list_changed` are forwarded. `initialize` is answered by Sagaz itself (it cannot be forwarded verbatim with N downstreams); downstream `instructions` are concatenated and passed on (known pending: label each block with its server name once multi-server setups are common). Resources and prompts are not proxied yet and are not announced in capabilities.

The repo ships a `.mcp.json` and a `sagaz.config.json` wired this way, so Claude Code opened in this directory drives the [toybox](packages/toybox/README.md) world through Sagaz.

## License

MIT
