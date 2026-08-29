import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, effectHash, genesisHash, sha256Hex } from "../src/ledger/hash.js";
import { ApprovalError, Ledger, PENDING_HASH, truncateJson, type TruncatedResult } from "../src/ledger/ledger.js";
import { ulid } from "../src/ledger/ulid.js";

let dir: string;
let ledger: Ledger;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sagaz-ledger-"));
  tick = 0;
  ledger = new Ledger(join(dir, "nested", "dir", "ledger.db"), { clock, maxResultBytes: 64 });
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ulid", () => {
  it("is 26 chars, sortable, and monotonic within a millisecond", () => {
    const a = ulid(1000);
    const b = ulid(1000);
    const c = ulid(1001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });
});

describe("canonical hashing", () => {
  const base = {
    id: "01H", session_id: "S", seq: 1, ts_start: "t0", ts_end: "t1", server: "toybox", tool: "send_email",
    args_json: '{"to":"a@b.c"}', pre_state_json: null, result_json: '{"ok":true}', status: "ok", class: null,
  };
  it("serializes exactly the 12 keys, sorted, no whitespace, nulls kept", () => {
    expect(canonicalize(base)).toBe(
      '{"args_json":"{\\"to\\":\\"a@b.c\\"}","class":null,"id":"01H","pre_state_json":null,"result_json":"{\\"ok\\":true}","seq":1,"server":"toybox","session_id":"S","status":"ok","tool":"send_email","ts_end":"t1","ts_start":"t0"}',
    );
  });
  it("hash = sha256(prev_hash || canonical), hex; genesis = sha256('sagaz-genesis:' + id)", () => {
    expect(effectHash("prev", base)).toBe(sha256Hex("prev" + canonicalize(base)));
    expect(genesisHash("S")).toBe(sha256Hex("sagaz-genesis:S"));
    expect(effectHash("prev", { ...base, seq: 2 })).not.toBe(effectHash("prev", base));
  });
});

describe("effect lifecycle", () => {
  it("creates the directory, opens a session with client info and genesis hash", () => {
    expect(existsSync(join(dir, "nested", "dir", "ledger.db"))).toBe(true);
    const s = ledger.openSession({ clientInfo: { name: "claude-code", version: "1.0" }, configHash: "cfg" });
    expect(s.genesis_hash).toBe(genesisHash(s.id));
    expect(ledger.getSession(s.id)).toEqual(s);
    expect(JSON.parse(s.client_info ?? "")).toEqual({ name: "claude-code", version: "1.0" });
  });

  it("begin inserts pending with seq and no hash; end stores the outcome, hashes and chains", () => {
    const s = ledger.openSession({});
    const id1 = ledger.begin({ sessionId: s.id, server: "toybox", tool: "list_contacts", args: {}, classification: { class: "read", source: "annotation", reason: "readOnlyHint: true" } });
    const pending = ledger.get(id1);
    expect(pending).toMatchObject({ seq: 1, status: "pending", prev_hash: PENDING_HASH, hash: PENDING_HASH, ts_end: null, result_json: null, class: "read", class_source: "annotation" });

    const closed1 = ledger.end(id1, { status: "ok", result: { rows: 3 } });
    expect(closed1.prev_hash).toBe(s.genesis_hash);
    expect(closed1.hash).toBe(effectHash(s.genesis_hash, closed1));
    expect(closed1.result_json).toBe('{"rows":3}');
    expect(closed1.ts_end).not.toBeNull();

    const id2 = ledger.begin({ sessionId: s.id, server: "toybox", tool: "send_email", args: { to: "x@y.z" } });
    const closed2 = ledger.end(id2, { status: "error", result: { isError: true } });
    expect(closed2.seq).toBe(2);
    expect(closed2.prev_hash).toBe(closed1.hash);
    expect(closed2.class).toBeNull();
    expect(ledger.verifySession(s.id)).toMatchObject({ ok: true });
    expect(ledger.verifySession(s.id).chain.map((e) => e.seq)).toEqual([1, 2]);

    expect(() => ledger.end(id2, { status: "ok", result: null })).toThrow(/already closed/);
  });

  it("chains in closing order when calls overlap; a never-closed effect stays pending and outside the chain", () => {
    const s = ledger.openSession({});
    const a = ledger.begin({ sessionId: s.id, server: "t", tool: "slow", args: {} });
    const b = ledger.begin({ sessionId: s.id, server: "t", tool: "fast", args: {} });
    const crashed = ledger.begin({ sessionId: s.id, server: "t", tool: "never_returns", args: {} });
    const closedB = ledger.end(b, { status: "ok", result: 1 });
    const closedA = ledger.end(a, { status: "ok", result: 2 });
    expect(closedB.prev_hash).toBe(s.genesis_hash);
    expect(closedA.prev_hash).toBe(closedB.hash);
    expect(ledger.get(crashed)).toMatchObject({ status: "pending", hash: PENDING_HASH, seq: 3 });
    const v = ledger.verifySession(s.id);
    expect(v.ok).toBe(true);
    expect(v.chain.map((e) => e.tool)).toEqual(["fast", "slow"]);
    expect(ledger.listEffects(s.id)).toHaveLength(3);
  });

  it("chains correctly when several effects close within the same millisecond (constant clock)", () => {
    const frozen = new Ledger(join(dir, "frozen.db"), { clock: () => "2026-01-01T00:00:00.000Z" });
    try {
      const s = frozen.openSession({});
      const a = frozen.begin({ sessionId: s.id, server: "t", tool: "a", args: {} });
      const b = frozen.begin({ sessionId: s.id, server: "t", tool: "b", args: {} });
      const c = frozen.begin({ sessionId: s.id, server: "t", tool: "c", args: {} });
      const closedC = frozen.end(c, { status: "ok", result: null });
      const closedA = frozen.end(a, { status: "ok", result: null });
      const closedB = frozen.end(b, { status: "ok", result: null });
      expect(closedC.prev_hash).toBe(s.genesis_hash);
      expect(closedA.prev_hash).toBe(closedC.hash);
      expect(closedB.prev_hash).toBe(closedA.hash);
      const v = frozen.verifySession(s.id);
      expect(v.ok).toBe(true);
      expect(v.chain.map((e) => e.tool)).toEqual(["c", "a", "b"]);
    } finally {
      frozen.close();
    }
  });

  it("refuses to extend a session's chain from another instance, and end() rejects unknown ids", () => {
    const s = ledger.openSession({});
    ledger.end(ledger.begin({ sessionId: s.id, server: "t", tool: "a", args: {} }), { status: "ok", result: 1 });
    const other = new Ledger(join(dir, "nested", "dir", "ledger.db"), { clock });
    try {
      const id = other.begin({ sessionId: s.id, server: "t", tool: "b", args: {} });
      expect(() => other.end(id, { status: "ok", result: 1 })).toThrow(/another process/);
      expect(() => other.end("nope", { status: "ok", result: 1 })).toThrow(/not found/);
    } finally {
      other.close();
    }
  });

  it("seq is per session", () => {
    const s1 = ledger.openSession({});
    const s2 = ledger.openSession({});
    ledger.begin({ sessionId: s1.id, server: "t", tool: "a", args: {} });
    const inS2 = ledger.begin({ sessionId: s2.id, server: "t", tool: "b", args: {} });
    expect(ledger.get(inS2)?.seq).toBe(1);
  });
});

describe("truncation", () => {
  it("leaves small results alone and marks large ones (valid JSON, hashed as stored)", () => {
    expect(truncateJson('{"a":1}', 64)).toBe('{"a":1}');
    const big = JSON.stringify({ blob: "x".repeat(500) });
    const stored = truncateJson(big, 64);
    const marker = JSON.parse(stored) as TruncatedResult;
    expect(marker.$truncated).toEqual({ original_bytes: Buffer.byteLength(big), kept_bytes: 64 });
    expect(marker.prefix).toBe(big.slice(0, 64));

    const s = ledger.openSession({});
    const id = ledger.begin({ sessionId: s.id, server: "t", tool: "read_file", args: {} });
    const row = ledger.end(id, { status: "ok", result: { blob: "x".repeat(500) } });
    expect(row.result_json).toBe(stored);
    expect(row.hash).toBe(effectHash(s.genesis_hash, row));
  });
  it("cuts on a UTF-8 boundary", () => {
    const stored = truncateJson(JSON.stringify({ s: "ééééééééééééééééééééééééééééééééééééééé" }), 10);
    const marker = JSON.parse(stored) as TruncatedResult;
    expect(marker.prefix).not.toContain("�");
    expect(marker.$truncated.kept_bytes).toBeLessThanOrEqual(10);
  });
});

describe("tamper evidence", () => {
  it("detects an edited row", () => {
    const s = ledger.openSession({});
    const id = ledger.begin({ sessionId: s.id, server: "t", tool: "x", args: { n: 1 } });
    ledger.end(id, { status: "ok", result: 1 });
    const raw = new Database(join(dir, "nested", "dir", "ledger.db"));
    raw.prepare("UPDATE effects SET args_json = ? WHERE id = ?").run('{"n":2}', id);
    raw.close();
    expect(ledger.verifySession(s.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/hash mismatch at seq 1/) });
  });

  it("detects a closed tail row flipped back to pending, and a deleted middle row", () => {
    const s = ledger.openSession({});
    const ids = ["a", "b", "c"].map((t) => ledger.begin({ sessionId: s.id, server: "t", tool: t, args: {} }));
    for (const id of ids) ledger.end(id, { status: "ok", result: 1 });
    const raw = new Database(join(dir, "nested", "dir", "ledger.db"));
    raw.prepare("UPDATE effects SET status = 'pending' WHERE id = ?").run(ids[2]);
    expect(ledger.verifySession(s.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/marked pending but carries a hash/) });
    raw.prepare("UPDATE effects SET status = 'ok' WHERE id = ?").run(ids[2]);
    raw.prepare("DELETE FROM effects WHERE id = ?").run(ids[1]);
    raw.close();
    expect(ledger.verifySession(s.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/unreachable from genesis/) });
  });
});

describe("approvals (confirm gates)", () => {
  function held(): { effectId: string; approvalId: string } {
    const s = ledger.openSession({});
    const effectId = ledger.begin({ sessionId: s.id, server: "bank", tool: "transfer_funds", args: { amount_cents: 5 }, classification: { class: "I", source: "rule", reason: "transfer_*" } });
    return { effectId, approvalId: ledger.requestApproval(effectId).id };
  }

  it("requestApproval opens a row for a pending effect only; pending lists it joined with the effect", () => {
    const { effectId, approvalId } = held();
    expect(ledger.getApproval(approvalId)).toMatchObject({ effect_id: effectId, decided_at: null, decision: null, decided_by: null });
    expect(ledger.listPendingApprovals()).toMatchObject([{ id: approvalId, tool: "transfer_funds", server: "bank", class: "I", args_json: '{"amount_cents":5}' }]);
    ledger.end(effectId, { status: "blocked", result: {} });
    expect(() => ledger.requestApproval(effectId)).toThrow(/already closed \(blocked\)/);
    expect(() => ledger.requestApproval("nope")).toThrow(/not found/);
  });

  it("decide is once-only and atomic; a second decision reports the standing one", () => {
    const { approvalId } = held();
    const other = new Ledger(join(dir, "nested", "dir", "ledger.db")); // the CLI: another connection
    try {
      expect(other.decide(approvalId, "allow", "jero")).toMatchObject({ decision: "allow", decided_by: "jero" });
      expect(() => ledger.decide(approvalId, "deny", "timeout")).toThrow(ApprovalError);
      expect(() => ledger.decide(approvalId, "deny", "timeout")).toThrow(/Already decided: allow by jero/);
      expect(() => ledger.decide("nope", "deny", "x")).toThrow(/not found/);
      expect(ledger.listPendingApprovals()).toEqual([]);
    } finally {
      other.close();
    }
  });

  it("findApprovalsByEffect: exact id, else unique suffix (what the CLI prints)", () => {
    const { effectId, approvalId } = held();
    expect(ledger.findApprovalsByEffect(effectId).map((a) => a.id)).toEqual([approvalId]);
    expect(ledger.findApprovalsByEffect(effectId.slice(-8)).map((a) => a.id)).toEqual([approvalId]);
    expect(ledger.findApprovalsByEffect("zzzzzzzz")).toEqual([]);
  });

  it("waitForDecision resolves when another connection decides, and denies by 'timeout' otherwise", async () => {
    const a = held();
    const other = new Ledger(join(dir, "nested", "dir", "ledger.db"));
    try {
      setTimeout(() => other.decide(a.approvalId, "allow", "jero"), 30);
      const decided = await ledger.waitForDecision(a.approvalId, { timeoutMs: 5_000, pollMs: 5 });
      expect(decided).toMatchObject({ decision: "allow", decided_by: "jero" });

      const b = held();
      const timedOut = await ledger.waitForDecision(b.approvalId, { timeoutMs: 40, pollMs: 5 });
      expect(timedOut).toMatchObject({ decision: "deny", decided_by: "timeout" });
      expect(timedOut.decided_at).not.toBeNull();
      // Late approval is refused, not silently swallowed.
      expect(() => other.decide(b.approvalId, "allow", "jero")).toThrow(/Already decided: deny by timeout/);
    } finally {
      other.close();
    }
  });

  it("mustExist refuses to create a ledger; readonly ledgers without the table report nothing pending", () => {
    expect(() => new Ledger(join(dir, "missing.db"), { mustExist: true })).toThrow(/No ledger at/);
    const raw = new Database(join(dir, "old.db"));
    raw.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, client_info TEXT, config_hash TEXT, genesis_hash TEXT NOT NULL)");
    raw.close();
    const old = new Ledger(join(dir, "old.db"), { readonly: true });
    expect(old.listPendingApprovals()).toEqual([]);
    old.close();
  });
});
