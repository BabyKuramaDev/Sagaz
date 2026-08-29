/**
 * Built-in name heuristics (classifier level 3). Conservative by design.
 *
 * Governing principle: class R means "we know how to execute the inverse", and a name alone
 * never proves that. So only `create_*` yields R (its inverse — delete what was created — is
 * derivable from the result without pre-state). `update_*` / `delete_*` are mutations whose
 * inverse needs the previous state; by name they are `unknown` until a capture hook, a
 * compensation pack or a user rule says otherwise. A false "reversible" is the worst error the
 * system can make; an `unknown` is only a warning.
 *
 * The table is documented for users in packages/core/README.md — keep both in sync.
 */
import type { EffectClass } from "../ledger/ledger.js";

/** First word of the tool name → class. Order is irrelevant: words are unique. */
export const HEURISTICS: ReadonlyArray<{ verbs: readonly string[]; class: EffectClass; why: string }> = [
  {
    verbs: ["list", "get", "read", "search", "find", "fetch", "query", "describe", "show", "count", "check", "view"],
    class: "read",
    why: "reads do not change the world",
  },
  { verbs: ["create"], class: "R", why: "the inverse (delete what was created) is derivable from the result" },
  {
    verbs: ["send", "post", "publish", "notify", "message", "reply", "comment"],
    class: "C",
    why: "cannot be unsent; a semantic correction is possible",
  },
  {
    verbs: ["transfer", "pay", "charge", "execute", "drop", "wipe", "purge", "destroy"],
    class: "I",
    why: "no inverse exists once it has happened",
  },
  {
    verbs: ["update", "delete", "remove", "set", "patch", "put", "run"],
    class: "unknown",
    why: "a mutation whose inverse needs the previous state; a name alone never proves reversibility",
  },
];

/**
 * Reduces a tool name to the verb the heuristics key on:
 *   `gmail.sendEmail` → `send`, `toybox__list_contacts` → `list`, `DropTable` → `drop`.
 * Takes the last namespace segment (after `.`, `/`, `:` or `__`), splits camelCase into
 * snake_case, lowercases, and keeps the first `_`-separated token.
 */
export function leadingVerb(toolName: string): string {
  const segments = toolName.split(/__|[./:]/);
  const last = segments[segments.length - 1] ?? toolName;
  const snake = last.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return snake.split(/[_\-\s]+/).find((t) => t.length > 0) ?? snake;
}

export interface HeuristicMatch {
  class: EffectClass;
  reason: string;
}

/** `undefined` when no verb matches — the caller falls through to `unknown`. */
export function matchHeuristic(toolName: string): HeuristicMatch | undefined {
  const verb = leadingVerb(toolName);
  for (const row of HEURISTICS) {
    if (row.verbs.includes(verb)) return { class: row.class, reason: `built-in heuristic ${verb}_* → ${row.class}: ${row.why}` };
  }
  return undefined;
}
