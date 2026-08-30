/**
 * What the agent reads when a gate stops a call. The gate speaks, it does not moo: every
 * template says what was stopped, why (class + policy), that the action did NOT happen, that
 * it must not retry, that the operator knows, and what it can do instead. Returned as a tool
 * result with `isError: true` so the model treats it as a failed call, never as a success.
 *
 * Documented in packages/core/README.md ("What the agent sees"). Keep both in sync. The fourth
 * outcome, `cancelled`, is not a message for the agent (it already hung up) — only a ledger record.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PolicyAction } from "../config.js";
import type { EffectClass } from "../ledger/ledger.js";

export type GateOutcome = "blocked" | "denied" | "timeout" | "cancelled";

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
        `The attempt is recorded in the Sagaz effect ledger for the operator to see. ${NEXT_STEPS}`,
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
        `The attempt is recorded in the Sagaz effect ledger for the operator to see. ${NEXT_STEPS}`,
      ].join("\n");
    case "cancelled":
      // The agent cancelled or disconnected while the call was held; nobody reads this reply.
      // It exists so the ledger row closes with an honest result like every other stop.
      return `Sagaz was holding ${what} for operator confirmation when the caller cancelled the request. It was NOT executed and nothing changed.\n${why}`;
  }
}

export function gateResult(ctx: GateContext, meta: GateMeta): CallToolResult {
  return { content: [{ type: "text", text: gateMessage(ctx) }], isError: true, _meta: { sagaz: meta } };
}

// ---- preview (effect preview, `sagaz serve --preview`) -----------------------------------

/** What the proxy attaches to a dry reply (`_meta.sagaz`) — and therefore stores as result_json. */
export interface PreviewMeta {
  preview: true;
  class: EffectClass;
  /** What the active policy would have done had this not been a preview. Never applied. */
  wouldHave: PolicyAction;
  policy: string;
}

export interface PreviewContext {
  tool: string;
  server: string;
  class: EffectClass;
  wouldHave: PolicyAction;
}

const WOULD_HAVE: Record<PolicyAction, string> = {
  allow: "it would have run",
  confirm: "it would have waited for the operator's approval",
  block: "the policy would have blocked it",
};

/**
 * Spoken like the gate templates, but it is not an error: the agent is planning, and a plan is
 * exactly what preview mode wants. `isError: false` so the model keeps going instead of
 * treating every mutation as a failure; the text makes sure it does not believe anything happened.
 */
export function previewMessage(ctx: PreviewContext): string {
  return [
    `Preview mode: this call was recorded but NOT executed. \`${ctx.tool}\` on server "${ctx.server}" did not run and nothing changed.`,
    `It would have been classified ${CLASS_LABEL[ctx.class]}; outside preview ${WOULD_HAVE[ctx.wouldHave]}.`,
    "Continue planning as if it had succeeded — nothing you do in this session reaches the real world. Do not retry it; the operator will review what you would have done.",
  ].join("\n");
}

export function previewResult(ctx: PreviewContext, meta: PreviewMeta): CallToolResult {
  return { content: [{ type: "text", text: previewMessage(ctx) }], isError: false, _meta: { sagaz: meta } };
}

/** Text the agent sees in `instructions` at initialize when preview mode is on. */
export const PREVIEW_INSTRUCTIONS =
  "Sagaz preview mode is active: read-only tools work normally, but every tool call that would change something is recorded and NOT executed. " +
  "Plan and act as you normally would; each such call answers with a note saying it was recorded but did not run. Nothing in this session reaches the real world.";

function formatWait(ms: number | undefined): string {
  if (ms === undefined) return "the configured timeout";
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}
