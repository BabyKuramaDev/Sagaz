# sagaz-toybox

A deliberately dangerous MCP server that simulates an **external world** — CRM, email, tweets, a bank — persisted in a SQLite file you can inspect from outside the agent. It exists for Sagaz's e2e tests and for demos: every reel starts with an agent breaking this world.

```sh
sagaz-toybox seed      # reset the world with deterministic sample data
sagaz-toybox           # serve on stdio (MCP)
sagaz-toybox inspect   # dump the whole world, human-readable
```

State lives in `$TOYBOX_DB` (default `./toybox.db`). Seed data is the same every time (Ada, Grace, Linus; accounts `acc-ops` $5,000 / `acc-payroll` $10,000 / `acc-vendor` $0), so tests and recordings are reproducible.

## Connect to Claude Code

```sh
claude mcp add toybox -e TOYBOX_DB=/absolute/path/toybox.db -- node /absolute/path/packages/toybox/dist/index.js
```

The repo's own `.mcp.json` registers the toybox **through Sagaz** (`sagaz serve --config sagaz.config.json`) — that is the intended demo path. To register it directly instead:

```json
{ "mcpServers": { "toybox": { "command": "node", "args": ["packages/toybox/dist/index.js"], "env": { "TOYBOX_DB": "./toybox.db" } } } }
```

## Tools and the R/C/I taxonomy

The world is built so that each domain lands in one class of the taxonomy on purpose. The **Class** column is the *intended* class — what a complete Sagaz (packs + capture hooks) should reach; today's name heuristics land on `unknown` where an inverse needs pre-state, as noted.

| Tool | Domain | Class | MCP annotations | Why |
|---|---|---|---|---|
| `list_contacts` | CRM | read | `readOnlyHint: true` | correctly annotated read |
| `get_contact` | CRM | read | `readOnlyHint: true` | the capture read: fetches the row an inverse of `delete_contact`/`update_contact` will need |
| `create_contact` | CRM | **R** | *none* | inverse: `delete_contact`. Accepts `company: null` so an inverse derived from a captured pre-state can say "no company" |
| `update_contact` | CRM | **R** | *none* | inverse: `update_contact` with the previous values (needs capture — by name alone the classifier says `unknown`) |
| `delete_contact` | CRM | **R** | `destructiveHint: true` | inverse: `create_contact` with the deleted row (needs capture — by name alone the classifier says `unknown`) |
| `send_email` | Comms | **C** | *none* | cannot be unsent; a correction can be sent with `in_reply_to` |
| `list_inbox` | Comms | read | `readOnlyHint: true` | correctly annotated read |
| `post_tweet` | Comms | **C** | *none* | can be deleted afterwards (soft delete), but it was public meanwhile |
| `delete_tweet` | Comms | **C** | `destructiveHint: true` | the deletion itself has no inverse in the world (by name alone: `unknown`) |
| `list_timeline` | Comms | read | *none* | a read **without** `readOnlyHint` — the classifier must infer it |
| `list_accounts` | Bank | read | `readOnlyHint: true` | correctly annotated read |
| `transfer_funds` | Bank | **I** | *none* | **the trap**: moves money, nothing in the metadata says "irreversible" |

**Annotations are mixed on purpose.** The classifier cascades user rules → annotations → name heuristics → `unknown` (see [`packages/core/README.md`](../core/README.md)), and it needs both paths exercised: tools with correct hints (`list_contacts`, `get_contact`, `list_inbox`, `list_accounts`, `delete_contact`, `delete_tweet`) and tools with none (`create_contact`, `update_contact`, `send_email`, `post_tweet`, `list_timeline`, `transfer_funds`).

**Deferred:** `drop_everything` (wipe the whole world in one call, the SPEC's example of a catastrophic tool) is intentionally not implemented yet; it lands with the Phase 2 rollback demo.

World errors (unknown id, duplicate email, insufficient funds…) come back as tool results with `isError: true`, never as protocol errors. Deleted tweets stay in the DB flagged `[DELETED]` and the transfer log is never pruned, so `inspect` always tells the full story.
