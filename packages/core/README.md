# sagaz-core

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

## Gates: what happens once a call has a class

The classifier annotates; the **policy** decides. Every `tools/call` goes classify → evaluate policy → record → gate:

| Action | What Sagaz does |
|---|---|
| `allow` | forwards the call as usual |
| `confirm` | records the attempt, **holds the call** until you run `sagaz approve <id>` or `sagaz deny <id>` (or `policy.confirmTimeoutMs` elapses, which counts as deny), then follows the decision |
| `block` | records the attempt and answers the agent without ever forwarding the call |

A blocked or denied attempt closes as `status = 'blocked'` in the ledger — hashed and chained like any other effect. A stopped call is auditable history; that is the point.

### The factory policy: the guardian

Without any configuration, **`I` → `confirm`** and everything else (`read`, `R`, `C`, `unknown`) → `allow`. Irreversible calls wait for a human; the rest flows and is only recorded.

### Your policy

```json
{
  "servers": { "crm": { "command": "..." }, "bank": { "command": "..." } },
  "policy": {
    "class": { "I": "block", "unknown": "confirm" },
    "tools": [
      { "tool": "transfer_funds", "server": "bank", "action": "confirm", "reason": "payroll runs need a human" },
      { "tool": "send_*", "action": "confirm" }
    ],
    "confirmTimeoutMs": 120000
  }
}
```

Precedence, first hit wins:

1. **`tools`** — same matching as classification rules: exact tool name or glob (`*`), optional `server`, file order. A tool rule beats the class map.
2. **`class`** — per class; your entries override the factory map key by key (`{ "I": "allow" }` switches the guardian off and leaves the rest alone).
3. the factory map above.

`reason` (optional) is stored as the gate reason and shown to the agent; it defaults to a description of the rule.

Approvals travel through the ledger (`approvals` table — `docs/T0-recon-y-schema.md` §4c): the proxy holds the call and polls, `sagaz approve` / `sagaz deny` write the decision from any other terminal. The agent never sees the wait — an approved call returns exactly what the downstream returned.

### What the agent sees

A gate speaks; it does not moo. Every stopped call comes back as a tool result with **`isError: true`** (the action did *not* happen, and the model must know it) and a text written to be read by an LLM: what was stopped, why (class + policy), that it must not retry, that the operator knows, and what it can do instead. The gate metadata (`gate`, `class`, `policy`, `approvalId`, `decidedBy`, `waitedMs`) travels in `_meta.sagaz`, so `result_json` in the ledger is exactly what the agent received. Source: `src/policy/templates.ts`. (A fourth outcome, `cancelled`, closes the row when the agent cancels or disconnects while held — nobody reads that reply, and a later `sagaz approve` is refused.)

**Blocked by policy**

```
Sagaz blocked this call before it reached the server. `transfer_funds` on server "bank" was NOT executed and nothing changed.
Reason: this tool is classified I (irreversible); policy.class I → block.
Do not retry this call and do not try to achieve the same effect another way — the policy will block it again.
The attempt is recorded in the Sagaz effect ledger for the operator to see. You may continue with other tasks that do not depend on this action, or report this to the user.
```

**Held, then denied by the operator**

```
Sagaz held this call for operator confirmation and the operator (jero) denied it. `transfer_funds` on server "bank" was NOT executed and nothing changed.
Reason: this tool is classified I (irreversible); default policy: class I → confirm.
Do not retry this call and do not try to achieve the same effect another way — it was explicitly denied.
The operator already knows about this attempt; it is recorded in the Sagaz effect ledger. You may continue with other tasks that do not depend on this action, or report this to the user.
```

**Held, then nobody answered in time**

```
Sagaz held this call for operator confirmation and no decision arrived within 120s, so it is treated as denied. `transfer_funds` on server "bank" was NOT executed and nothing changed.
Reason: this tool is classified I (irreversible); default policy: class I → confirm.
Do not retry this call — a retry would wait again and the policy is unchanged.
The attempt is recorded in the Sagaz effect ledger for the operator to see. You may continue with other tasks that do not depend on this action, or report this to the user.
```

## Preview: the session runs dry

`sagaz serve --preview`, or `"preview": true` in the config (`ProxyOptions.preview` in code), turns the whole session into an *effect preview*. It is a session mode, not a per-tool one: run the agent end to end, touch nothing, keep the ledger.

| Class (by the full cascade) | In preview |
|---|---|
| `read` | forwarded as usual — the agent must be able to see the world to plan anything |
| `R`, `C`, `I`, `unknown` | classified, recorded as `status = 'dry'`, answered with the note below, **never forwarded** |

The policy does not run in preview: nothing executes, so there is nothing to confirm or block, and an `I` call closes as `dry` — never `pending`, never waiting. The verdict is still *computed* and travels with the reply as `_meta.sagaz.wouldHave` (`allow` | `confirm` | `block`) plus its reason, so `sagaz preview-report` can say "would have waited for your approval". Dry rows are hashed and chained like any other effect.

**The honest edge.** "Read" is whatever the cascade says: a mutating tool that declares `readOnlyHint: true`, or one your rules misclassify as `read`, *is* forwarded in preview. Sagaz cannot know better than its classifier. That is exactly why `unknown` is treated as a mutation: when in doubt, dry.

### What the agent sees in preview

At `initialize`, prepended to the downstream instructions:

```
Sagaz preview mode is active: read-only tools work normally, but every tool call that would change something is recorded and NOT executed. Plan and act as you normally would; each such call answers with a note saying it was recorded but did not run. Nothing in this session reaches the real world.
```

For every dry call, as a tool result with **`isError: false`** — the agent is planning, and a plan is what preview wants; the text makes sure it does not believe anything happened. Metadata `{ preview: true, class, wouldHave, policy }` in `_meta.sagaz`, hence in `result_json`. Source: `src/policy/templates.ts`.

```
Preview mode: this call was recorded but NOT executed. `transfer_funds` on server "bank" did not run and nothing changed.
It would have been classified I (irreversible); outside preview it would have waited for the operator's approval.
Continue planning as if it had succeeded — nothing you do in this session reaches the real world. Do not retry it; the operator will review what you would have done.
```
