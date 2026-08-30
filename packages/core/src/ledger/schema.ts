/**
 * Effect ledger schema v1 — FROZEN, plus the one amendment the T0 document allows.
 * Source of truth: docs/T0-recon-y-schema.md §3, amended by §4d (T11): `class_source` gains
 * the value 'pack' — a compensation pack deciding the class is provenance of its own, not a
 * built-in rule and not a user rule. Reproduced verbatim (comments trimmed). Do not edit
 * without amending the T0 document.
 *
 * The effects DDL is built from one template so the §4d migration (SQLite cannot alter a
 * CHECK; the table must be rebuilt) creates the replacement table from exactly the same text.
 */
const EFFECTS_DDL = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
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
                   ('annotation','rule','llm','user','pack')),
  class_reason   TEXT,
  undo_json      TEXT,
  undo_status    TEXT NOT NULL DEFAULT 'none' CHECK (undo_status IN
                   ('none','planned','proposed','approved',
                    'executed','failed','impossible')),
  compensates_id TEXT REFERENCES effects(id),
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  UNIQUE (session_id, seq)
);`;

const EFFECTS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_effects_session ON effects (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_effects_tool    ON effects (tool);
CREATE INDEX IF NOT EXISTS idx_effects_class   ON effects (class);
CREATE INDEX IF NOT EXISTS idx_effects_undo    ON effects (undo_status)
  WHERE undo_status IN ('proposed','approved');
`;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  client_info TEXT,
  config_hash TEXT,
  genesis_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ts          TEXT NOT NULL,
  label       TEXT,
  auto        INTEGER NOT NULL DEFAULT 0
);
${EFFECTS_DDL("effects")}
${EFFECTS_INDEXES}`;

/**
 * Approvals (T8 amendment, docs/T0-recon-y-schema.md §4c). A separate table: the frozen
 * `effects` DDL and its hash are untouched. One row per `confirm` gate; the operator's
 * decision (`sagaz approve` / `deny`) lands here from another process and the proxy polls it.
 * `decided_by` is 'timeout' when nobody answered in time (the call is then treated as denied).
 */
export const SCHEMA_APPROVALS_V1 = `
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  effect_id    TEXT NOT NULL REFERENCES effects(id),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decision     TEXT CHECK (decision IN ('allow','deny')),
  decided_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_effect ON approvals (effect_id);
CREATE INDEX IF NOT EXISTS idx_approvals_open   ON approvals (requested_at)
  WHERE decided_at IS NULL;
`;

/** The minimal shape of a better-sqlite3 Database this module needs (avoids the hard import). */
interface SqliteLike {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
  pragma(sql: string): unknown;
  transaction(fn: () => void): () => void;
}

/**
 * T0 §4d migration: rebuilds `effects` so the class_source CHECK admits 'pack'. SQLite cannot
 * alter a CHECK, so this is the documented table-rebuild dance (sqlite.org/lang_altertable
 * "making other kinds of table schema changes"), run inside one transaction with foreign keys
 * off. Content is copied verbatim — the hash chain does not include class_source (hash.ts, 12
 * canonical keys), so every old row verifies exactly as before. Idempotent: a ledger whose DDL
 * already admits 'pack' is left alone. Called on every writable open; readonly opens skip it
 * (reading old rows needs no migration — only writing 'pack' does).
 */
export function migrateClassSourcePack(db: SqliteLike): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'effects'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'pack'")) return false;
  db.pragma("foreign_keys = OFF"); // a no-op inside a transaction, so set it before
  try {
    const migrate = db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS effects_migrated");
      db.exec(EFFECTS_DDL("effects_migrated").replace("REFERENCES effects(id)", "REFERENCES effects_migrated(id)"));
      db.exec(`INSERT INTO effects_migrated
        SELECT id, session_id, checkpoint_id, seq, ts_start, ts_end, server, tool, args_json,
               pre_state_json, result_json, status, class, class_source, class_reason,
               undo_json, undo_status, compensates_id, prev_hash, hash
        FROM effects`);
      db.exec("DROP TABLE effects");
      db.exec("ALTER TABLE effects_migrated RENAME TO effects");
      db.exec(EFFECTS_INDEXES);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`class_source migration would leave ${broken.length} broken foreign key reference(s) — rolled back`);
    });
    migrate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return true;
}
