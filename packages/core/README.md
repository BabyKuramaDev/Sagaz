# @sagaz/core

The proxy and the effect ledger behind the [`sagaz`](../cli) CLI. You normally do not import this package; it documents the two contracts users interact with through `sagaz.config.json`: **classification** (this file) and the **ledger hash chain** (`src/ledger/hash.ts`).

## How an effect gets its class

Every `tools/call` is classified before it is forwarded, and the result (`class`, `class_source`, `class_reason`) is written into the effect row and sealed into its hash. In Phase 1 the classifier only annotates — it never blocks.

Precedence, first hit wins:

| Level | Source | `class_source` | What it looks at |
|---|---|---|---|
| 1 | **your rules** in `sagaz.config.json` | `user` | tool name (exact or glob), optional server |
| 2 | MCP tool annotations | `annotation` | `readOnlyHint: true` → `read` |
| 3 | built-in name heuristics | `rule` | the first word of the tool name (table below) |
| 4 | nothing matched | `rule` | → `unknown` |

Your rules **always** win. Annotations are what the server *declares* about itself, not revealed truth; only you know your world.

`destructiveHint: true` is not a class by itself (destructive ≠ irreversible, and it says nothing about whether an inverse is known). It acts as a cap: whatever the heuristics say, the result can never be `R`.

### The governing principle

**`R` means "Sagaz knows how to execute the inverse."** A tool name alone never proves that. So the heuristics are conservative on purpose: when in doubt, `unknown`. A false "reversible" would later auto-execute a wrong compensation — the worst error the system can make. An `unknown` is only a warning, and a one-line rule fixes it.

### Built-in heuristics

The classifier reduces the tool name to its first word (`gmail.sendEmail` → `send`, `toybox__list_contacts` → `list`, `DropTable` → `drop`) and looks it up:

| First word | Class | Why |
|---|---|---|
| `list` `get` `read` `search` `find` `fetch` `query` `describe` `show` `count` `check` `view` | `read` | reads do not change the world |
| `create` | **R** | the inverse (delete what was created) is derivable from the result, no pre-state needed |
| `send` `post` `publish` `notify` `message` `reply` `comment` | **C** | cannot be unsent; a semantic correction is possible |
| `transfer` `pay` `charge` `execute` `drop` `wipe` `purge` `destroy` | **I** | no inverse exists once it has happened |
| `update` `delete` `remove` `set` `patch` `put` `run` | `unknown` | a mutation whose inverse needs the previous state — by name alone, nobody knows it |
| anything else | `unknown` | no signal |

A read verb up front does not make the whole name a read: `get_or_create_user`, `search_and_destroy`, `list_and_delete` → `unknown` (the name also contains a mutating verb).

`update_*` / `delete_*` will become `R` only when a compensation pack with a capture hook exists for that tool (Phase 2), or when you say so with a rule.

Source: `src/classifier/heuristics.ts`. Keep this table and that file in sync.

### Your rules

```json
{
  "servers": { "crm": { "command": "..." }, "bank": { "command": "..." } },
  "rules": [
    { "tool": "delete_contact", "server": "crm", "class": "R", "reason": "soft delete, restore_contact exists" },
    { "tool": "*_draft", "class": "R" },
    { "tool": "transfer_funds", "server": "bank", "class": "I" }
  ]
}
```

- `tool` — exact downstream tool name (before any Sagaz `prefix`), or a glob where `*` matches any run of characters.
- `server` — optional; restricts the rule to that downstream. Without it the rule applies to every server.
- `class` — one of `read`, `R`, `C`, `I`, `unknown`.
- `reason` — optional; stored verbatim as `class_reason`. Defaults to a description of the rule.
- First matching rule in file order wins.

Rules are not retroactive: effects already in the ledger keep the class they were sealed with.
