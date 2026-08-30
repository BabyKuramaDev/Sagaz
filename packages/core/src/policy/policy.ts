/**
 * Gates: what happens to a call once it has a class. Runs after classify() and before the call
 * is forwarded — the classifier annotates, the policy decides.
 *
 * Precedence (first hit wins):
 *   1. `policy.tools` in sagaz.config.json — exact or glob tool name, optional server; file order
 *   2. `policy.class` — user entries override the factory map key by key
 *   3. the factory map: I → confirm, everything else → allow (the guardian default)
 *
 * Actions: `allow` forwards as usual; `block` records the attempt and answers without forwarding;
 * `confirm` records the attempt, waits for `sagaz approve` / `sagaz deny` and follows the decision
 * (a timeout counts as deny). Blocked and denied attempts are ledger rows like any other — a
 * stopped call is auditable history, that is the point.
 */
import { DEFAULT_CLASS_POLICY, type PolicyAction, type PolicyConfig } from "../config.js";
import { globToRegExp } from "../glob.js";
import type { EffectClass } from "../ledger/ledger.js";

export interface PolicyVerdict {
  action: PolicyAction;
  /** Which rule decided, human-readable — becomes the gate reason in the ledger and in the reply. */
  reason: string;
}

export interface PolicyInput {
  /** Name as the downstream server knows it (before any Sagaz prefix). */
  tool: string;
  server: string;
  class: EffectClass;
  policy?: PolicyConfig | undefined;
}

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const tools = input.policy?.tools ?? [];
  const rule = tools.find((r) => (r.server === undefined || r.server === input.server) && globToRegExp(r.tool).test(input.tool));
  if (rule) {
    const scope = rule.server ? `${rule.server}/${rule.tool}` : rule.tool;
    return { action: rule.action, reason: rule.reason ?? `policy.tools ${scope} → ${rule.action}` };
  }
  const fromUser = input.policy?.class[input.class];
  if (fromUser !== undefined) return { action: fromUser, reason: `policy.class ${input.class} → ${fromUser}` };
  const factory = DEFAULT_CLASS_POLICY[input.class];
  return { action: factory, reason: `default policy: class ${input.class} → ${factory}` };
}
