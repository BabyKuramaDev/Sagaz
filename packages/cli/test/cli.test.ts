import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "@sagaz/core";
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
