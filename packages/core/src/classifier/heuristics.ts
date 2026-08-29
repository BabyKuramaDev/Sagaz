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

/** Every verb the table treats as a mutation (anything that is not `read`). */
const MUTATING_VERBS = new Set(HEURISTICS.filter((r) => r.class !== "read").flatMap((r) => r.verbs));

/**
 * Tokens of a tool name: last namespace segment (after `.`, `/`, `:` or `__`), camelCase split
 * into words, lowercased. `gmail.sendEmail` → ["send","email"], `toybox__list_contacts` → ["list","contacts"].
 */
export function nameTokens(toolName: string): string[] {
  const segments = toolName.split(/__|[./:]/);
  const last = segments[segments.length - 1] ?? toolName;
  const snake = last.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return snake.split(/[_\-\s]+/).filter((t) => t.length > 0);
}

/**
 * Reduces a tool name to the verb the heuristics key on:
 *   `gmail.sendEmail` → `send`, `toybox__list_contacts` → `list`, `DropTable` → `drop`.
 * Takes the last namespace segment (after `.`, `/`, `:` or `__`), splits camelCase into
 * snake_case, lowercases, and keeps the first `_`-separated token.
 */
export function leadingVerb(toolName: string): string {
  return nameTokens(toolName)[0] ?? "";
}

export interface HeuristicMatch {
  class: EffectClass;
  reason: string;
}

/** `undefined` when no verb matches — the caller falls through to `unknown`. */
export function matchHeuristic(toolName: string): HeuristicMatch | undefined {
  const tokens = nameTokens(toolName);
  const verb = tokens[0] ?? "";
  const row = HEURISTICS.find((r) => r.verbs.includes(verb));
  if (!row) return undefined;
  // A read verb up front does not make the whole name a read: `get_or_create_user`,
  // `search_and_destroy`, `list_and_delete`. Any mutating verb later in the name → unknown.
  if (row.class === "read") {
    const mutating = tokens.slice(1).find((t) => MUTATING_VERBS.has(t));
    if (mutating) return { class: "unknown", reason: `compound name: starts with ${verb}_* but contains ${mutating}; a name alone never proves reversibility` };
  }
  return { class: row.class, reason: `built-in heuristic ${verb}_* → ${row.class}: ${row.why}` };
}
