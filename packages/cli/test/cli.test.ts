import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "sagaz-core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlags } from "../src/args.js";
import { colourEnabled, formatBytes, formatDuration, makeStyle, table } from "../src/format.js";

const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (!existsSync(bin)) throw new Error(`CLI bin not built (${bin}). Run \`pnpm build\` before \`pnpm test\`.`);

let dir: string;
let configPath: string;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 7, 29, 12, 0, 0, tick++ * 150)).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sagaz-cli-"));
  tick = 0;
  configPath = join(dir, "sagaz.config.json");
  writeFileSync(configPath, JSON.stringify({ servers: { toybox: { command: "node" } }, ledger: { path: "ledger.db" } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sagaz(...args: string[]) {
  const r = spawnSync(process.execPath, [bin, "--config", configPath, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A ledger with one session: the reel, plus one never-closed effect. */
function seedLedger(): string {
  const ledger = new Ledger(join(dir, "ledger.db"), { clock });
  const s = ledger.openSession({ clientInfo: { name: "claude-code", version: "2.0.0" } });
  const ops: [string, boolean, boolean][] = [["list_accounts", true, false], ["create_contact", false, false], ["send_email", false, false], ["transfer_funds", false, true]];
  for (const [tool, read, isError] of ops) {
    const id = ledger.begin({
      sessionId: s.id, server: "toybox", tool, args: { x: 1 },
      classification: read ? { class: "read", source: "annotation", reason: "readOnlyHint: true" } : undefined,
    });
    ledger.end(id, { status: isError ? "error" : "ok", result: { content: [{ type: "text", text: "{}" }], isError } });
  }
  ledger.begin({ sessionId: s.id, server: "toybox", tool: "never_returns", args: {} });
  ledger.close();
  return s.id;
}

describe("sagaz bin", () => {
  it("prints a version and exits 0", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^sagaz \d+\.\d+\.\d+ \(core \d+\.\d+\.\d+\)$/);
  });
  it("exits 1 with usage on unknown commands/flags", () => {
    expect(sagaz("bogus")).toMatchObject({ code: 1, err: expect.stringMatching(/Unknown command: bogus/) });
    expect(sagaz("ledger", "--status", "weird")).toMatchObject({ code: 1, err: expect.stringMatching(/--status must be one of/) });
  });
  it("status and ledger explain a missing ledger instead of creating one", () => {
    expect(sagaz("status")).toMatchObject({ code: 0, out: expect.stringMatching(/no ledger yet/) });
    expect(sagaz("ledger")).toMatchObject({ code: 1, err: expect.stringMatching(/No ledger at .*run `sagaz serve` first/) });
    expect(existsSync(join(dir, "ledger.db"))).toBe(false);
  });
});

describe("sagaz ledger / status / verify on a populated ledger", () => {
  let sessionId: string;
  beforeEach(() => {
    sessionId = seedLedger();
  });

  it("ledger renders the table with class, status, duration and result size; filters work", () => {
    const { code, out } = sagaz("ledger");
    expect(code).toBe(0);
    expect(out).toContain(`session ${sessionId}`);
    expect(out).toMatch(/seq\s+tool\s+server\s+class\s+status\s+duration\s+result\s+id/);
    expect(out).toMatch(/1\s+list_accounts\s+toybox\s+read\s+ok\s+150ms\s+\d+B/);
    expect(out).toMatch(/4\s+transfer_funds\s+toybox\s+-\s+error/);
    expect(out).toMatch(/5\s+never_returns\s+toybox\s+-\s+pending\s+…\s+-/);
    expect(out).toContain("5 effect(s)");

    expect(sagaz("ledger", "--tool", "send_email").out).toMatch(/send_email[\s\S]*1 effect\(s\)/);
    expect(sagaz("ledger", "--status", "error").out).toMatch(/transfer_funds[\s\S]*1 effect\(s\)/);
    expect(sagaz("ledger", "--session", sessionId.slice(0, 10)).out).toContain("5 effect(s)");
    expect(sagaz("ledger", "--session", "nope")).toMatchObject({ code: 1, err: expect.stringMatching(/^sagaz: No session matches "nope"/) });
    expect(sagaz("ledger", "--session", "%")).toMatchObject({ code: 1 });
  });

  it("rejects ambiguous prefixes, reports empty sessions, validates --last", () => {
    const ledger = new Ledger(join(dir, "ledger.db"), { clock });
    const s2 = ledger.openSession({});
    ledger.close();
    expect(sagaz("ledger", "--session", sessionId.slice(0, 4))).toMatchObject({ code: 1, err: expect.stringMatching(/is ambiguous: .*, /) });
    expect(sagaz("ledger", "--session", s2.id).out).toContain("no effects match");
    expect(sagaz("status", "--last", "1").out).not.toContain(sessionId);
    expect(sagaz("status", "--last", "abc")).toMatchObject({ code: 1, err: expect.stringMatching(/--last must be a positive integer/) });
  });

  it("ledger --json emits one raw row per line", () => {
    const lines = sagaz("ledger", "--json").out.trim().split("\n").map((l) => JSON.parse(l) as { seq: number; hash: string });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(lines[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[4]?.hash).toBe("");
  });

  it("status lists sessions, counts and pending", () => {
    const { code, out } = sagaz("status");
    expect(code).toBe(0);
    expect(out).toContain("servers  toybox");
    expect(out).toMatch(/ledger\s+.*ledger\.db/);
    expect(out).toMatch(/1 session\(s\), 5 effect\(s\), 1 pending/);
    expect(out).toMatch(new RegExp(`${sessionId}\\s+2026-08-29 12:00:00Z\\s+claude-code 2\\.0\\.0\\s+5 \\(1 pending\\)`));
  });

  it("verify walks the chain and reports OK, then BROKEN after tampering", () => {
    const ok = sagaz("verify");
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/✓ seq\s+1\s+list_accounts/);
    expect(ok.out).toMatch(/OK 4 effect\(s\) chained, 1 pending \(never closed\)/);

    const raw = new Database(join(dir, "ledger.db"));
    raw.prepare("UPDATE effects SET args_json = '{\"x\":2}' WHERE seq = 2").run();
    raw.close();
    const broken = sagaz("verify");
    expect(broken.code).toBe(2);
    expect(broken.out).toMatch(/BROKEN after 1 verified effect\(s\): hash mismatch at seq 2/);
  });
});

describe("format helpers", () => {
  it("respects NO_COLOR and FORCE_COLOR", () => {
    expect(colourEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colourEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colourEnabled({}, false)).toBe(false);
    expect(colourEnabled({}, true)).toBe(true);
  });
  it("aligns columns ignoring ANSI codes", () => {
    const s = makeStyle(true);
    const t = table([{ header: "a" }, { header: "n", align: "right" }], [[s.green("ok"), "5"], ["error", "10"]], makeStyle(false));
    expect(t.split("\n")[2]).toBe(`${s.green("ok")}      5`);
  });
  it("formats durations and sizes", () => {
    expect(formatDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.250Z")).toBe("250ms");
    expect(formatDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:02.500Z")).toBe("2.50s");
    expect(formatDuration("2026-01-01T00:00:00.000Z", null)).toBe("…");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(70_000)).toBe("68.4KB");
  });
  it("parses value flags and boolean flags", () => {
    expect(parseFlags(["ledger", "--tool", "x", "--json", "--session=last"], ["tool", "session"])).toEqual({ positional: ["ledger"], flags: { tool: "x", json: true, session: "last" } });
    expect(() => parseFlags(["--tool"], ["tool"])).toThrow(/requires a value/);
  });
});

describe("sagaz pending / approve / deny", () => {
  /** A session with one held transfer (pending effect + open approval) and one blocked-by-policy call. */
  function seedHeld(): { effectId: string; sessionId: string } {
    const ledger = new Ledger(join(dir, "ledger.db"), { clock });
    const s = ledger.openSession({ clientInfo: { name: "claude-code", version: "2.0.0" } });
    const blocked = ledger.begin({ sessionId: s.id, server: "toybox", tool: "transfer_funds", args: { amount_cents: 1 }, classification: { class: "I", source: "rule", reason: "transfer_*" } });
    ledger.end(blocked, {
      status: "blocked",
      result: { content: [{ type: "text", text: "Sagaz blocked this call" }], isError: true, _meta: { sagaz: { gate: "denied", class: "I", policy: "default policy: class I → confirm", decidedBy: "jero" } } },
    });
    const effectId = ledger.begin({
      sessionId: s.id, server: "toybox", tool: "transfer_funds",
      args: { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 250_000, memo: "a memo long enough to be cut in the table" },
      classification: { class: "I", source: "rule", reason: "transfer_*" },
    });
    ledger.requestApproval(effectId);
    ledger.close();
    return { effectId, sessionId: s.id };
  }

  it("pending lists held calls with short id, class, summarized args and waiting time; status counts them", () => {
    const { effectId } = seedHeld();
    const { code, out } = sagaz("pending");
    expect(code).toBe(0);
    expect(out).toMatch(/id\s+tool\s+server\s+class\s+args\s+waiting/);
    expect(out).toMatch(new RegExp(`${effectId.slice(-8)}\\s+transfer_funds\\s+toybox\\s+I\\s+from_account=acc-payroll, to_account=acc-vendor…\\s+\\S+`));
    expect(out).toContain("1 call(s) held — sagaz approve <id> | sagaz deny <id>");
    expect(sagaz("status").out).toMatch(/1 pending, 1 waiting for approval \(sagaz pending\)/);
  });

  it("approve/deny decide by short id, once; unknown and missing ids are errors; never creates a ledger", () => {
    expect(sagaz("approve", "abc")).toMatchObject({ code: 1, err: expect.stringMatching(/No ledger at/) });
    expect(existsSync(join(dir, "ledger.db"))).toBe(false);
    const { effectId } = seedHeld();
    expect(sagaz("approve")).toMatchObject({ code: 1, err: expect.stringMatching(/sagaz approve needs the id of a held call/) });
    expect(sagaz("deny", "zzzzzzzz")).toMatchObject({ code: 1, err: expect.stringMatching(/^sagaz: No held call matches "zzzzzzzz"/) });

    // Blank --by falls back to the system user.
    expect(sagaz("approve", effectId.slice(-8), "--by", "")).toMatchObject({ code: 0, out: expect.stringMatching(/approved transfer_funds \S+ by \S+/) });
    const second = seedHeld().effectId;
    const ok = sagaz("approve", second.slice(-8), "--by", "jero");
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe(`approved transfer_funds ${second.slice(-8)} by jero`);
    expect(sagaz("pending").out).toContain("nothing is waiting for approval");
    expect(sagaz("deny", second)).toMatchObject({ code: 1, err: expect.stringMatching(/Already decided: allow by jero/) });

    const ledger = new Ledger(join(dir, "ledger.db"), { readonly: true });
    expect(ledger.findApprovalsByEffect(second)[0]).toMatchObject({ decision: "allow", decided_by: "jero" });
    ledger.close();
  });

  it("ledger shows blocked in red with the gate reason, only when something was gated", () => {
    seedHeld();
    const plain = sagaz("ledger").out;
    expect(plain).toMatch(/1\s+transfer_funds\s+toybox\s+I\s+blocked\s+150ms\s+\d+B\s+\S+\s+denied by jero — default policy: class I → confirm/);
    expect(plain).toMatch(/2\s+transfer_funds\s+toybox\s+I\s+pending/);
    const colour = spawnSync(process.execPath, [bin, "--config", configPath, "ledger"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "1" } }).stdout;
    expect(colour).toContain("\x1b[31mblocked\x1b[39m");
    expect(colour).toContain("\x1b[31mdenied by jero");
    expect(sagaz("ledger", "--status", "pending").out).not.toMatch(/gate/);
  });
});

describe("sagaz preview-report / ledger on a dry session", () => {
  const dryResult = (cls: string, wouldHave: string) => ({
    content: [{ type: "text", text: "Preview mode: this call was recorded but NOT executed." }], isError: false,
    _meta: { sagaz: { preview: true, class: cls, wouldHave, policy: `default policy: class ${cls} → ${wouldHave}` } },
  });

  /** The reel run through `sagaz serve --preview`: two reads executed, four calls dry. */
  function seedDry(): string {
    const ledger = new Ledger(join(dir, "ledger.db"), { clock });
    const s = ledger.openSession({ clientInfo: { name: "claude-code", version: "2.0.0" } });
    const add = (tool: string, cls: "read" | "R" | "C" | "I" | "unknown", args: unknown, wouldHave?: string) => {
      const id = ledger.begin({ sessionId: s.id, server: "toybox", tool, args, classification: { class: cls, source: "rule", reason: "test" } });
      if (wouldHave) ledger.end(id, { status: "dry", result: dryResult(cls, wouldHave) });
      else ledger.end(id, { status: "ok", result: { content: [{ type: "text", text: "[]" }] } });
    };
    add("list_contacts", "read", {});
    add("list_timeline", "read", {});
    add("send_email", "C", { to: "ada@analytical.engine", subject: "Welcome", body: "Hi" }, "allow");
    add("send_email", "C", { to: "grace@cobol.navy", subject: "Welcome", body: "Hi" }, "allow");
    add("transfer_funds", "I", { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 250_000 }, "confirm");
    add("delete_contact", "unknown", { id: 1 }, "block");
    ledger.close();
    return s.id;
  }

  it("preview-report groups the dry effects by class, says what the policy would have done, and lists them", () => {
    seedDry();
    const { code, out } = sagaz("preview-report");
    expect(code).toBe(0);
    expect(out).toContain("Nothing reached the world. 6 call(s): 2 read(s) executed, 4 recorded dry.");
    expect(out).toMatch(/I\s+1\s+transfer_funds\n\s+irreversible: no way back once executed; it would have waited for your approval/);
    expect(out).toMatch(/C\s+2\s+send_email ×2\n\s+compensable: cannot be undone, only corrected afterwards; all would have run without asking/);
    expect(out).toMatch(/unknown\s+1\s+delete_contact\n\s+reversibility unknown.*; it would have been blocked by policy/);
    expect(out).not.toMatch(/\bR\s+\d/);
    expect(out).toMatch(/seq\s+tool\s+server\s+class\s+outside preview\s+args/);
    expect(out).toMatch(/5\s+transfer_funds\s+toybox\s+I\s+would wait for approval\s+from_account=acc-payroll/);
    expect(out).toMatch(/6\s+delete_contact\s+toybox\s+unknown\s+would be blocked\s+id=1/);
    expect(out).not.toMatch(/list_contacts/);
  });

  it("preview-report --json, and honest messages for sessions that did not run dry", () => {
    seedDry();
    const json = JSON.parse(sagaz("preview-report", "--json").out) as { reads: number; dry: unknown[]; groups: { class: string; count: number }[] };
    expect(json.reads).toBe(2);
    expect(json.dry).toHaveLength(4);
    expect(json.groups.map((g) => [g.class, g.count])).toEqual([["I", 1], ["C", 2], ["unknown", 1]]);

    // verify from the CLI: dry rows are part of the chain.
    expect(sagaz("verify").out).toContain("OK 6 effect(s) chained");

    seedLedger();
    expect(sagaz("preview-report").out).toContain("nothing ran dry in this session — was it started with `sagaz serve --preview`?");
    expect(sagaz("preview-report", "--session", "nope")).toMatchObject({ code: 1, err: expect.stringMatching(/No session matches "nope"/) });
  });

  it("a mixed session is not sold as clean, and a dry row without metadata is shown honestly", () => {
    const ledger = new Ledger(join(dir, "ledger.db"), { clock });
    const s = ledger.openSession({});
    const ran = ledger.begin({ sessionId: s.id, server: "toybox", tool: "post_tweet", args: {}, classification: { class: "C", source: "rule", reason: "t" } });
    ledger.end(ran, { status: "ok", result: {} });
    const bare = ledger.begin({ sessionId: s.id, server: "toybox", tool: "send_email", args: {}, classification: { class: "C", source: "rule", reason: "t" } });
    ledger.end(bare, { status: "dry", result: { content: [] } });
    const failedRead = ledger.begin({ sessionId: s.id, server: "toybox", tool: "list_inbox", args: {}, classification: { class: "read", source: "annotation", reason: "t" } });
    ledger.end(failedRead, { status: "error", result: {} });
    ledger.close();
    const out = sagaz("preview-report").out;
    expect(out).toContain("2 non-read call(s) DID reach the world — not a clean preview. 3 call(s): 0 read(s) executed, 1 recorded dry.");
    expect(out).toMatch(/C\s+1\s+send_email\n\s+compensable.*; it carried no policy verdict/);
    expect(out).toMatch(/2\s+send_email\s+toybox\s+C\s+-\n/);
    expect(sagaz("ledger").out).toMatch(/dry\s+150ms\s+\d+B\s+\S+\s+not executed — -/);
  });

  it("ledger marks dry rows and shows the preview column only when something ran dry", () => {
    seedDry();
    const plain = sagaz("ledger").out;
    expect(plain).toMatch(/status\s+duration\s+result\s+id\s+preview/);
    expect(plain).toMatch(/5\s+transfer_funds\s+toybox\s+I\s+dry\s+150ms\s+\d+B\s+\S+\s+not executed — would wait for approval/);
    expect(plain).toMatch(/1\s+list_contacts\s+toybox\s+read\s+ok\s+150ms\s+\d+B\s+\S+\n/);
    expect(plain).toContain("6 effect(s) — 4 recorded dry, not executed (sagaz preview-report)");
    expect(plain).not.toMatch(/gate/);
    const colour = spawnSync(process.execPath, [bin, "--config", configPath, "ledger"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "1" } }).stdout;
    expect(colour).toContain("\x1b[35mdry\x1b[39m");
    expect(colour).toContain("\x1b[35mnot executed\x1b[39m");
    expect(sagaz("ledger", "--status", "ok").out).not.toMatch(/preview/);
  });
});

describe("sagaz ledger undo column / status dry counts (T10)", () => {
  /** One planned inverse, one no-plan with its reason, one dry row. */
  beforeEach(() => {
    const ledger = new Ledger(join(dir, "ledger.db"), { clock });
    const s = ledger.openSession({ clientInfo: { name: "claude-code", version: "2.0.0" } });
    const planned = ledger.begin({ sessionId: s.id, server: "toybox", tool: "create_contact", args: { name: "Ada" }, classification: { class: "R", source: "rule", reason: "create_*" } });
    ledger.end(planned, { status: "ok", result: { content: [{ type: "text", text: '{"id":4}' }] } });
    ledger.setUndo(planned, { undoStatus: "planned", undoJson: { kind: "tool_call", server: "toybox", tool: "delete_contact", args: { id: 4 } } });
    const noPlan = ledger.begin({ sessionId: s.id, server: "toybox", tool: "delete_contact", args: { id: 1 } });
    ledger.end(noPlan, { status: "ok", result: { content: [] } });
    ledger.setUndo(noPlan, { undoStatus: "none", undoJson: { kind: "no_plan", reason: "capture read get_contact failed: gone" } });
    const dry = ledger.begin({ sessionId: s.id, server: "toybox", tool: "post_tweet", args: { text: "hi" }, classification: { class: "C", source: "rule", reason: "post_*" } });
    ledger.end(dry, { status: "dry", result: { content: [] } });
    ledger.close();
  });

  it("shows the undo column only when a pack had something to say: the plan status, or a dim no-plan", () => {
    const out = sagaz("ledger").out;
    expect(out).toMatch(/result\s+id\s+undo/);
    expect(out).toMatch(/create_contact[^\n]*\bplanned\b/);
    expect(out).toMatch(/delete_contact[^\n]*\bno plan\b/);
    // --json carries the plan and the no-plan descriptor in full.
    const rows = sagaz("ledger", "--json").out.trim().split("\n").map((l) => JSON.parse(l) as { undo_json: string | null; undo_status: string });
    expect(JSON.parse(rows[0]!.undo_json ?? "")).toEqual({ kind: "tool_call", server: "toybox", tool: "delete_contact", args: { id: 4 } });
    expect(rows[0]!.undo_status).toBe("planned");
    expect(JSON.parse(rows[1]!.undo_json ?? "")).toEqual({ kind: "no_plan", reason: "capture read get_contact failed: gone" });
    // A ledger with no undo activity keeps the narrow table.
    rmSync(join(dir, "ledger.db"));
    seedLedger();
    expect(sagaz("ledger").out).not.toMatch(/undo/);
  });

  it("status counts dry effects in the state line and per session", () => {
    const out = sagaz("status").out;
    expect(out).toContain("1 session(s), 3 effect(s), 1 dry");
    expect(out).toMatch(/claude-code 2\.0\.0\s+3 \(1 dry\)/);
  });
});
