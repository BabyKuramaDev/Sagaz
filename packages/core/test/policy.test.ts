import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRM_TIMEOUT_MS, parseConfig } from "../src/config.js";
import { PREVIEW_INSTRUCTIONS, evaluatePolicy, gateMessage, gateResult, previewMessage, previewResult } from "../src/policy/index.js";

const servers = { bank: { command: "x" } };

describe("policy config", () => {
  it("defaults to the guardian policy when the section is absent", () => {
    const cfg = parseConfig({ servers });
    expect(cfg.policy).toEqual({ class: {}, tools: [], confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS });
  });
  it("accepts class map, tool rules and timeout; rejects unknown actions and classes", () => {
    const cfg = parseConfig({ servers, policy: { class: { unknown: "confirm" }, tools: [{ tool: "transfer_*", server: "bank", action: "block" }], confirmTimeoutMs: 5 } });
    expect(cfg.policy.class).toEqual({ unknown: "confirm" });
    expect(cfg.policy.tools[0]).toMatchObject({ tool: "transfer_*", action: "block" });
    expect(cfg.policy.confirmTimeoutMs).toBe(5);
    expect(() => parseConfig({ servers, policy: { class: { I: "ask" } } })).toThrow(/policy\.class\.I/);
    expect(() => parseConfig({ servers, policy: { class: { X: "allow" } } })).toThrow(/policy\.class/);
    expect(() => parseConfig({ servers, policy: { tools: [{ tool: "a", action: "maybe" }] } })).toThrow(/policy\.tools\.0\.action/);
    expect(() => parseConfig({ servers, policy: { confirmTimeoutMs: 0 } })).toThrow(/policy\.confirmTimeoutMs/);
  });
});

describe("evaluatePolicy", () => {
  it("guardian default without config: I → confirm, everything else → allow", () => {
    const at = (cls: "read" | "R" | "C" | "I" | "unknown") => evaluatePolicy({ tool: "t", server: "s", class: cls }).action;
    expect(at("I")).toBe("confirm");
    expect(at("read")).toBe("allow");
    expect(at("R")).toBe("allow");
    expect(at("C")).toBe("allow");
    expect(at("unknown")).toBe("allow");
    expect(evaluatePolicy({ tool: "t", server: "s", class: "I" }).reason).toBe("default policy: class I → confirm");
  });
  it("user class entries override the factory map key by key", () => {
    const policy = parseConfig({ servers, policy: { class: { unknown: "confirm", I: "allow" } } }).policy;
    expect(evaluatePolicy({ tool: "t", server: "s", class: "unknown", policy })).toEqual({ action: "confirm", reason: "policy.class unknown → confirm" });
    expect(evaluatePolicy({ tool: "t", server: "s", class: "I", policy }).action).toBe("allow");
    expect(evaluatePolicy({ tool: "t", server: "s", class: "C", policy }).action).toBe("allow");
  });
  it("a tool rule beats the class map; exact/glob and server scoping, first match wins", () => {
    const policy = parseConfig({
      servers,
      policy: {
        class: { I: "block" },
        tools: [
          { tool: "transfer_funds", server: "bank", action: "allow", reason: "payroll bot is trusted" },
          { tool: "send_*", action: "confirm" },
          { tool: "send_*", action: "block" },
        ],
      },
    }).policy;
    expect(evaluatePolicy({ tool: "transfer_funds", server: "bank", class: "I", policy })).toEqual({ action: "allow", reason: "payroll bot is trusted" });
    expect(evaluatePolicy({ tool: "transfer_funds", server: "other", class: "I", policy }).action).toBe("block");
    expect(evaluatePolicy({ tool: "send_email", server: "mail", class: "C", policy })).toEqual({ action: "confirm", reason: "policy.tools send_* → confirm" });
    expect(evaluatePolicy({ tool: "send_email", server: "mail", class: "read", policy }).action).toBe("confirm");
  });
});

describe("gate templates", () => {
  const base = { tool: "transfer_funds", server: "bank", class: "I" as const, policy: "default policy: class I → confirm" };
  it("blocked: what, why, do not retry, operator notified, what to do next", () => {
    const msg = gateMessage({ ...base, outcome: "blocked", policy: "policy.tools transfer_* → block" });
    expect(msg).toContain("Sagaz blocked this call before it reached the server");
    expect(msg).toContain('`transfer_funds` on server "bank" was NOT executed');
    expect(msg).toContain("classified I (irreversible); policy.tools transfer_* → block");
    expect(msg).toContain("Do not retry");
    expect(msg).toContain("recorded in the Sagaz effect ledger for the operator");
    expect(msg).toContain("continue with other tasks");
  });
  it("denied: names the operator", () => {
    const msg = gateMessage({ ...base, outcome: "denied", decidedBy: "jero" });
    expect(msg).toContain("the operator (jero) denied it");
    expect(msg).toContain("was NOT executed");
    expect(msg).toContain("explicitly denied");
  });
  it("timeout: says how long it waited and that it counts as denied", () => {
    const msg = gateMessage({ ...base, outcome: "timeout", waitedMs: 120_000 });
    expect(msg).toContain("no decision arrived within 120s, so it is treated as denied");
    expect(msg).toContain("was NOT executed");
    expect(gateMessage({ ...base, outcome: "timeout", waitedMs: 500 })).toContain("within 500ms");
  });
  it("gateResult is an error result carrying the gate metadata", () => {
    const r = gateResult({ ...base, outcome: "blocked" }, { gate: "blocked", class: "I", policy: base.policy });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(r._meta).toEqual({ sagaz: { gate: "blocked", class: "I", policy: base.policy } });
  });
});

describe("preview", () => {
  it("config: off by default, `preview: true` switches it on, anything else is rejected", () => {
    expect(parseConfig({ servers }).preview).toBe(false);
    expect(parseConfig({ servers, preview: true }).preview).toBe(true);
    expect(() => parseConfig({ servers, preview: "yes" })).toThrow(/preview/);
  });

  it("template: recorded not executed, the class, what the policy would have done, keep planning, do not retry — and it is not an error", () => {
    const ctx = { tool: "send_email", server: "mail", class: "C" as const, wouldHave: "allow" as const };
    const msg = previewMessage(ctx);
    expect(msg).toContain("Preview mode: this call was recorded but NOT executed. `send_email` on server \"mail\" did not run and nothing changed.");
    expect(msg).toContain("It would have been classified C (compensable, cannot be undone automatically); outside preview it would have run.");
    expect(msg).toContain("Continue planning as if it had succeeded — nothing you do in this session reaches the real world. Do not retry it");
    expect(previewMessage({ ...ctx, class: "I", wouldHave: "confirm" })).toContain("outside preview it would have waited for the operator's approval");
    expect(previewMessage({ ...ctx, wouldHave: "block" })).toContain("outside preview the policy would have blocked it");
    const result = previewResult(ctx, { preview: true, class: "C", wouldHave: "allow", policy: "default policy: class C → allow" });
    expect(result.isError).toBe(false);
    expect(result._meta).toEqual({ sagaz: { preview: true, class: "C", wouldHave: "allow", policy: "default policy: class C → allow" } });
    expect(PREVIEW_INSTRUCTIONS).toContain("recorded and NOT executed");
  });
});
