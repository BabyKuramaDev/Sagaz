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

The world is built so that each domain lands in one class of the taxonomy on purpose. The **Class** column is what the classifier reaches with the [official pack](#the-official-pack-sagaz-packjson) loaded; without it, the name heuristics land on `unknown` where an inverse needs pre-state, as noted.

| Tool | Domain | Class | MCP annotations | Why |
|---|---|---|---|---|
| `list_contacts` | CRM | read | `readOnlyHint: true` | correctly annotated read |
| `get_contact` | CRM | read | `readOnlyHint: true` | the capture read: fetches the row an inverse of `delete_contact`/`update_contact` will need |
| `create_contact` | CRM | **R** | *none* | inverse: `delete_contact`. Accepts `company: null` so an inverse derived from a captured pre-state can say "no company", and an optional `id` to **restore** a deleted contact under its original identity (see below) |
| `update_contact` | CRM | **R** | *none* | inverse: `update_contact` with the previous values (via the pack's capture — by name alone the classifier says `unknown`) |
| `delete_contact` | CRM | **R** | `destructiveHint: true` | inverse: `create_contact` with the deleted row, id included (via the pack's capture — by name alone the classifier says `unknown`) |
| `send_email` | Comms | **C** | *none* | cannot be unsent; a correction can be sent with `in_reply_to` |
| `list_inbox` | Comms | read | `readOnlyHint: true` | correctly annotated read |
| `post_tweet` | Comms | **C** | *none* | can be deleted afterwards (soft delete), but it was public meanwhile |
| `delete_tweet` | Comms | **C** | `destructiveHint: true` | the deletion itself has no inverse in the world (by name alone: `unknown`) |
| `list_timeline` | Comms | read | *none* | a read **without** `readOnlyHint` — the classifier must infer it |
| `list_accounts` | Bank | read | `readOnlyHint: true` | correctly annotated read |
| `transfer_funds` | Bank | **I** | *none* | **the trap**: moves money, nothing in the metadata says "irreversible" |

**Annotations are mixed on purpose.** The classifier cascades user rules → annotations → name heuristics → `unknown` (see [`packages/core/README.md`](../core/README.md)), and it needs both paths exercised: tools with correct hints (`list_contacts`, `get_contact`, `list_inbox`, `list_accounts`, `delete_contact`, `delete_tweet`) and tools with none (`create_contact`, `update_contact`, `send_email`, `post_tweet`, `list_timeline`, `transfer_funds`).

**Deferred:** `drop_everything` (wipe the whole world in one call, the SPEC's example of a catastrophic tool) is intentionally not implemented yet; it lands with the Phase 2 rollback demo.

## The official pack (`sagaz-pack.json`)

The toybox ships its compensation pack as a real file — [`sagaz-pack.json`](./sagaz-pack.json), loaded via `"packs"` in the repo's `sagaz.config.json` (format in [`packages/core/README.md`](../core/README.md)). It covers the three CRM mutations, and only them:

| Entry | Inverse | Derived from |
|---|---|---|
| `create_contact` | `delete_contact` | `$.result.id` — no capture needed |
| `delete_contact` | `create_contact` | the pre-state captured with `get_contact`, **id included** |
| `update_contact` | `update_contact` | the pre-state captured with `get_contact` |

**Restore semantics.** `create_contact` accepts an optional `id` so the inverse of a delete restores the contact *as the row it was* — same id, same identity — instead of a lookalike with a fresh id. A live id is never overwritten (`Contact N already exists`), and the id sequence always continues above any restored id. This is the toybox honouring the pack design principle: *every write tool must be able to express any state its capture read can return, or the inverse is inexpressible.* (One honest limit: `created_at` is assigned by the world and not restorable — identity comes back, the original timestamp does not.)

**Why the rest is NOT in the pack** — a pack only declares inverses that actually exist; for everything else, honesty:

- `send_email` — sending cannot be unsent. A follow-up "please ignore that" is a *semantic correction* (class **C**, Sagaz Phase 3), not a deterministic inverse.
- `post_tweet` — same story: it was public while it lasted; deleting afterwards does not unsee it. **C**.
- `delete_tweet` — **the didactic one, the R/C boundary.** Reposting the deleted text would create a *new* tweet: another id, another timestamp, none of the original's history. The world offers no way to give a tweet back its identity — unlike `create_contact(id)`, there is no `post_tweet(id)`. A deterministic inverse must restore identity, not just content; if the world does not allow it, the effect is **C**, and no pack entry can change that. Exactly the same problem `delete_contact` *would* have without restore semantics.
- `transfer_funds` — the money moved. **I**; nothing to declare.

Run `sagaz packs` to see this split live: the pack, its entries, and the uncovered tools with their classes.

World errors (unknown id, duplicate email, insufficient funds…) come back as tool results with `isError: true`, never as protocol errors. Deleted tweets stay in the DB flagged `[DELETED]` and the transfer log is never pruned, so `inspect` always tells the full story.
