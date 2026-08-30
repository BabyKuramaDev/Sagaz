/**
 * T0 §4d — the class_source CHECK migration (T11). A ledger written before T11 rejects
 * class_source = 'pack'; opening it writable rebuilds the effects table (SQLite cannot alter a
 * CHECK) without losing a row or breaking a hash. The "old" ledger is produced by writing real
 * chained effects with the current code and then rebuilding the table back to the frozen
 * pre-T11 DDL — same rows, old CHECK — which is exactly what a T10 ledger on disk looks like.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, type EffectRow } from "../src/ledger/ledger.js";

/** The effects DDL exactly as T4 froze it — class_source without 'pack'. */
const PRE_T11_EFFECTS_DDL = `
CREATE TABLE effects_old (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  checkpoint_id  TEXT REFERENCES checkpoints(id),
  seq            INTEGER NOT NULL,
  ts_start       TEXT NOT NULL,
  ts_end         TEXT,
  server         TEXT NOT NULL,
  tool           TEXT NOT NULL,
  args_json      TEXT NOT NULL,
  pre_state_json TEXT,
  result_json    TEXT,
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','ok','error','blocked','dry')),
  class          TEXT CHECK (class IN ('read','R','C','I','unknown')),
  class_source   TEXT CHECK (class_source IN
                   ('annotation','rule','llm','user')),
  class_reason   TEXT,
  undo_json      TEXT,
  undo_status    TEXT NOT NULL DEFAULT 'none' CHECK (undo_status IN
                   ('none','planned','proposed','approved',
                    'executed','failed','impossible')),
  compensates_id TEXT REFERENCES effects_old(id),
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  UNIQUE (session_id, seq)
);`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sagaz-migrate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A ledger with real chained history (ok, blocked, a pre-state, an approval, a pending crash), rebuilt to the pre-T11 DDL. */
function makeOldLedger(path: string): { sessionId: string; rows: EffectRow[] } {
  const ledger = new Ledger(path);
  const session = ledger.openSession({ clientInfo: { name: "old-client" }, configHash: "cafe" });
  const e1 = ledger.begin({ sessionId: session.id, server: "toybox", tool: "create_contact", args: { name: "Ada" }, classification: { class: "R", source: "rule", reason: "create_*" } });
  ledger.end(e1, { status: "ok", result: { id: 9 } });
  const e2 = ledger.begin({ sessionId: session.id, server: "toybox", tool: "delete_contact", args: { id: 9 }, classification: { class: "unknown", source: "rule", reason: "delete_* alone proves nothing" } });
  ledger.setPreState(e2, { content: [{ type: "text", text: '{"id":9,"name":"Ada"}' }] });
  ledger.end(e2, { status: "ok", result: { id: 9 } });
  ledger.setUndo(e2, { undoStatus: "planned", undoJson: { kind: "tool_call", server: "toybox", tool: "create_contact", args: { name: "Ada" } } });
  const e3 = ledger.begin({ sessionId: session.id, server: "toybox", tool: "transfer_funds", args: { amount_cents: 1 }, classification: { class: "I", source: "rule", reason: "transfer_*" } });
  ledger.requestApproval(e3);
  ledger.end(e3, { status: "blocked", result: { isError: true } });
  ledger.begin({ sessionId: session.id, server: "toybox", tool: "send_email", args: {} }); // stays pending: the honest crash trace
  const rows = ledger.listEffects(session.id);
  expect(ledger.verifySession(session.id)).toMatchObject({ ok: true });
  ledger.close();

  // Rebuild the table under the frozen pre-T11 DDL — the reverse of the migration under test.
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  raw.exec(PRE_T11_EFFECTS_DDL);
  raw.exec("INSERT INTO effects_old SELECT * FROM effects");
  raw.exec("DROP TABLE effects");
  raw.exec("ALTER TABLE effects_old RENAME TO effects");
  // Sanity: this IS an old ledger now — 'pack' violates its CHECK.
  expect(() =>
    raw.prepare("UPDATE effects SET class_source = 'pack' WHERE class_source = 'rule'").run(),
  ).toThrow(/CHECK constraint failed/);
  raw.close();
  return { sessionId: session.id, rows };
}

describe("class_source 'pack' migration (T0 §4d)", () => {
  it("a pre-T11 ledger migrates on writable open: same rows, same hashes, verify OK, and 'pack' now writes", () => {
    const path = join(dir, "old.db");
    const { sessionId, rows } = makeOldLedger(path);

    const migrated = new Ledger(path);
    // Not a row lost, not a byte changed — undo lifecycle and pending crash trace included.
    expect(migrated.listEffects(sessionId)).toEqual(rows);
    expect(migrated.verifySession(sessionId)).toMatchObject({ ok: true });
    // The approvals FK survived the rebuild.
    expect(migrated.listPendingApprovals()).toEqual([]);
    const ddl = (new Database(path, { readonly: true }).prepare("SELECT sql FROM sqlite_master WHERE name = 'effects'").get() as { sql: string }).sql;
    expect(ddl).toContain("'pack'");

    // And the whole point: a T11 classification writes and chains.
    const session = migrated.openSession({});
    const id = migrated.begin({
      sessionId: session.id, server: "toybox", tool: "delete_contact", args: { id: 1 },
      classification: { class: "R", source: "pack", reason: 'compensation pack "toybox-crm": inverse create_contact' },
    });
    migrated.end(id, { status: "ok", result: {} });
    expect(migrated.get(id)).toMatchObject({ class: "R", class_source: "pack" });
    expect(migrated.verifySession(session.id)).toMatchObject({ ok: true });
    migrated.close();

    // Idempotent: a second open finds 'pack' already admitted and leaves the table alone.
    const again = new Ledger(path);
    expect(again.listEffects(sessionId)).toEqual(rows);
    again.close();
  });

  it("a readonly open of a pre-T11 ledger does not migrate (cannot write) but reads and verifies fine", () => {
    const path = join(dir, "old-ro.db");
    const { sessionId, rows } = makeOldLedger(path);
    const reader = new Ledger(path, { readonly: true });
    expect(reader.listEffects(sessionId)).toEqual(rows);
    expect(reader.verifySession(sessionId)).toMatchObject({ ok: true });
    reader.close();
    const ddl = (new Database(path, { readonly: true }).prepare("SELECT sql FROM sqlite_master WHERE name = 'effects'").get() as { sql: string }).sql;
    expect(ddl).not.toContain("'pack'");
  });
});
