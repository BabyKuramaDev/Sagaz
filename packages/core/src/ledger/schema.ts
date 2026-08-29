/**
 * Effect ledger schema v1 — FROZEN. Source of truth: docs/T0-recon-y-schema.md §3.
 * Reproduced verbatim (comments trimmed). Do not edit without amending the T0 document.
 */
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

CREATE TABLE IF NOT EXISTS effects (
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
  compensates_id TEXT REFERENCES effects(id),
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_effects_session ON effects (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_effects_tool    ON effects (tool);
CREATE INDEX IF NOT EXISTS idx_effects_class   ON effects (class);
CREATE INDEX IF NOT EXISTS idx_effects_undo    ON effects (undo_status)
  WHERE undo_status IN ('proposed','approved');
`;

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
