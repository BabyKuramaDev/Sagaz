/**
 * R/C/I classifier, levels 1 and 2 (no LLM). Runs once per tools/call, before the call is
 * forwarded; the result is written into the effect row and sealed into its hash.
 *
 * Precedence (first hit wins):
 *   1. user rules from sagaz.config.json — ALWAYS win: annotations are the server's
 *      declaration, not revealed truth, and the user is the only one who knows their world
 *   2. MCP tool annotations — readOnlyHint: true → read
 *   3. built-in name heuristics (see heuristics.ts)
 *   4. unknown
 *
 * destructiveHint: true is not a class by itself (destructive ≠ irreversible, and it says
 * nothing about whether an inverse is known). It acts as a cap: whatever the heuristics say,
 * the result can never be R. (Settled at the T7 checkpoint under the "R = known inverse" rule.)
 *
 * In Phase 1 the classifier only annotates — it never blocks. Gates are a separate ticket.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ClassificationRule } from "../config.js";
import type { ClassSource, EffectClass } from "../ledger/ledger.js";
import { matchHeuristic } from "./heuristics.js";

export interface Classification {
  class: EffectClass;
  source: ClassSource;
  reason: string;
}

export interface ClassifyInput {
  /** Name as the downstream server knows it (before any Sagaz prefix). */
  tool: string;
  server: string;
  annotations?: ToolAnnotations | undefined;
  rules?: readonly ClassificationRule[] | undefined;
}

/** Glob with `*` as the only wildcard (any run of characters, including none). Anchored. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}

export function matchRule(rules: readonly ClassificationRule[], tool: string, server: string): ClassificationRule | undefined {
  return rules.find((r) => (r.server === undefined || r.server === server) && globToRegExp(r.tool).test(tool));
}

export function classify(input: ClassifyInput): Classification {
  const rule = matchRule(input.rules ?? [], input.tool, input.server);
  if (rule) {
    const scope = rule.server ? `${rule.server}/${rule.tool}` : rule.tool;
    return { class: rule.class, source: "user", reason: rule.reason ?? `user rule ${scope} → ${rule.class}` };
  }

  const ann = input.annotations;
  if (ann?.readOnlyHint === true) return { class: "read", source: "annotation", reason: "readOnlyHint: true" };

  const heuristic = matchHeuristic(input.tool);
  if (heuristic) {
    if (ann?.destructiveHint === true && heuristic.class === "R") {
      return { class: "unknown", source: "annotation", reason: `destructiveHint: true caps ${heuristic.reason.split(":")[0]} at unknown` };
    }
    return { class: heuristic.class, source: "rule", reason: heuristic.reason };
  }

  return { class: "unknown", source: "rule", reason: `no rule, annotation or built-in heuristic matches "${input.tool}"` };
}
