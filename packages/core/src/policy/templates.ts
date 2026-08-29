/**
 * What the agent reads when a gate stops a call. The gate speaks, it does not moo: every
 * template says what was stopped, why (class + policy), that the action did NOT happen, that
 * it must not retry, that the operator knows, and what it can do instead. Returned as a tool
 * result with `isError: true` so the model treats it as a failed call, never as a success.
 *
 * Documented in packages/core/README.md ("What the agent sees"). Keep both in sync.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EffectClass } from "../ledger/ledger.js";

export type GateOutcome = "blocked" | "denied" | "timeout";

export interface GateContext {
  tool: string;
  server: string;
  class: EffectClass;
  /** Why the policy applied (verdict reason). */
  policy: string;
  outcome: GateOutcome;
  /** For `timeout`: how long the call waited. */
  waitedMs?: number | undefined;
  /** For `denied`: who decided, if recorded. */
  decidedBy?: string | null | undefined;
}

/** Metadata the proxy attaches to the reply (`_meta.sagaz`) and therefore to result_json. */
export interface GateMeta {
  gate: GateOutcome;
  class: EffectClass;
  policy: string;
  approvalId?: string | undefined;
  decidedBy?: string | null | undefined;
  waitedMs?: number | undefined;
}

const CLASS_LABEL: Record<EffectClass, string> = {
  read: "read-only",
  R: "R (reversible)",
  C: "C (compensable, cannot be undone automatically)",
  I: "I (irreversible)",
  unknown: "unknown reversibility",
};

const NEXT_STEPS =
  "You may continue with other tasks that do not depend on this action, or report this to the user.";

export function gateMessage(ctx: GateContext): string {
  const what = `\`${ctx.tool}\` on server "${ctx.server}"`;
  const why = `Reason: this tool is classified ${CLASS_LABEL[ctx.class]}; ${ctx.policy}.`;
  switch (ctx.outcome) {
    case "blocked":
      return [
        `Sagaz blocked this call before it reached the server. ${what} was NOT executed and nothing changed.`,
        why,
        "Do not retry this call and do not try to achieve the same effect another way — the policy will block it again.",
        `The operator has been notified: the attempt is recorded in the Sagaz effect ledger. ${NEXT_STEPS}`,
      ].join("\n");
    case "denied":
      return [
        `Sagaz held this call for operator confirmation and the operator${ctx.decidedBy ? ` (${ctx.decidedBy})` : ""} denied it. ${what} was NOT executed and nothing changed.`,
        why,
        "Do not retry this call and do not try to achieve the same effect another way — it was explicitly denied.",
        `The operator already knows about this attempt; it is recorded in the Sagaz effect ledger. ${NEXT_STEPS}`,
      ].join("\n");
    case "timeout":
      return [
        `Sagaz held this call for operator confirmation and no decision arrived within ${formatWait(ctx.waitedMs)}, so it is treated as denied. ${what} was NOT executed and nothing changed.`,
        why,
        "Do not retry this call — a retry would wait again and the policy is unchanged.",
        `The operator has been notified: the attempt is recorded in the Sagaz effect ledger and can be re-run by them. ${NEXT_STEPS}`,
      ].join("\n");
  }
}

export function gateResult(ctx: GateContext, meta: GateMeta): CallToolResult {
  return { content: [{ type: "text", text: gateMessage(ctx) }], isError: true, _meta: { sagaz: meta } };
}

function formatWait(ms: number | undefined): string {
  if (ms === undefined) return "the configured timeout";
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}
