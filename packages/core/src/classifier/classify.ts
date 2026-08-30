/**
 * R/C/I classifier, levels 1–3 (no LLM). Runs once per tools/call, before the call is
 * forwarded; the result is written into the effect row and sealed into its hash.
 *
 * Precedence (first hit wins):
 *   1. user rules from sagaz.config.json — ALWAYS win: annotations are the server's
 *      declaration, not revealed truth, and the user is the only one who knows their world
 *   2. compensation packs (T11) — a matching entry means the inverse is DECLARED and its
 *      pre-state will be captured: exactly what "R = known inverse" demands, so → R
 *   3. MCP tool annotations — readOnlyHint: true → read
 *   4. built-in name heuristics (see heuristics.ts)
 *   5. unknown
 *
 * destructiveHint: true is not a class by itself (destructive ≠ irreversible, and it says
 * nothing about whether an inverse is known). It acts as a cap: whatever the heuristics say,
 * the result can never be R. (Settled at the T7 checkpoint under the "R = known inverse" rule.)
 * The cap does NOT apply to an R by pack: it existed precisely because the inverse was
 * unknown, and a pack is the inverse being known.
 *
 * The classifier only annotates — it never blocks. What happens next is policy/ (gates).
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ClassificationRule } from "../config.js";
import { globToRegExp } from "../glob.js";
import type { ClassSource, EffectClass } from "../ledger/ledger.js";
import { matchPack, type CompensationPack } from "../undo/packs.js";
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
  /**
   * Loaded compensation packs. The caller decides whether they are in force: the proxy passes
   * none when `"capture": false` — an inverse whose pre-state will never be captured is an
   * inverse Sagaz cannot execute, and claiming R then would be a false reversible.
   */
  packs?: readonly CompensationPack[] | undefined;
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

  // T11: a pack entry closes the T6/T7 circle — R because the inverse is declared and the
  // pre-state (when the inverse needs one) is captured before the call runs.
  const packed = matchPack(input.packs ?? [], input.tool, input.server);
  if (packed) {
    const via = packed.entry.capture
      ? "from the captured pre-state"
      : Object.values(packed.entry.inverse.args).some((ref) => ref.startsWith("$.result"))
        ? "from the result"
        : "from the call's args";
    return { class: "R", source: "pack", reason: `compensation pack "${packed.pack.name}": inverse ${packed.entry.inverse.tool} ${via}` };
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
