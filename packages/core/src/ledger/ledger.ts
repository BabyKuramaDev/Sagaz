/**
 * Effect ledger v1: append-only record of every tools/call that crosses the proxy.
 *
 * Lifecycle of an effect:
 *   begin()  → INSERT with status 'pending', seq assigned, prev_hash = hash = '' (sentinel:
 *              the frozen schema declares both NOT NULL; a pending row has no hash yet)
 *   end()    → UPDATE result_json / ts_end / status, then compute the hash and chain it.
 * Rows that stay 'pending' forever are the honest trace of a crash and are never cleaned up.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { effectHash, genesisHash, sha256Hex, type HashableEffect } from "./hash.js";
import { SCHEMA_V1 } from "./schema.js";
import { ulid } from "./ulid.js";

export const DEFAULT_LEDGER_PATH = "./.sagaz/ledger.db";
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;

/** Sentinel stored in prev_hash/hash while an effect is pending. */
export const PENDING_HASH = "";

export type EffectStatus = "pending" | "ok" | "error" | "blocked" | "dry";
export type EffectClass = "read" | "R" | "C" | "I" | "unknown";
export type ClassSource = "annotation" | "rule" | "llm" | "user";

export interface EffectRow extends HashableEffect {
  checkpoint_id: string | null;
  class_source: ClassSource | null;
  class_reason: string | null;
  undo_json: string | null;
  undo_status: string;
  compensates_id: string | null;
  prev_hash: string;
  hash: string;
}

export interface SessionRow {
  id: string;
  started_at: string;
  client_info: string | null;
  config_hash: string | null;
  genesis_hash: string;
}

export interface LedgerOptions {
  maxResultBytes?: number;
  clock?: () => string;
  /** Open for reading only: never creates the file or the schema. Throws if the file is missing. */
  readonly?: boolean;
}

export interface EffectFilter {
  tool?: string | undefined;
  status?: EffectStatus | undefined;
}

export interface SessionSummary extends SessionRow {
  effects: number;
  pending: number;
  last_ts: string | null;
}

export class LedgerNotFoundError extends Error {
  override readonly name = "LedgerNotFoundError";
}

export interface BeginEffectInput {
  sessionId: string;
  server: string;
  tool: string;
  args: unknown;
  /** Decided by the proxy before the call is forwarded; part of the hashed payload. Phase 0 only ever sets 'read'. */
  classification?: { class: EffectClass; source: ClassSource; reason: string } | undefined;
}

export interface EndEffectInput {
  status: Exclude<EffectStatus, "pending">;
  result: unknown;
}

/**
 * Truncation marker. When a serialized result exceeds maxResultBytes, result_json becomes
 * `{"$truncated":{"original_bytes":N,"kept_bytes":M},"prefix":"<first M bytes>"}` —
 * still valid JSON, self-describing, and hashed as stored. The prefix is cut on a UTF-8
 * character boundary so it stays a valid string. The stored text is the prefix plus ~70 bytes
 * of marker, so it can slightly exceed maxResultBytes; the limit bounds the payload, not the row.
 */
export interface TruncatedResult {
  $truncated: { original_bytes: number; kept_bytes: number };
  prefix: string;
}

export function truncateJson(json: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return json;
  let prefix = Buffer.from(json, "utf8").subarray(0, maxBytes).toString("utf8");
  // Drop a trailing replacement char produced by cutting inside a multi-byte sequence.
  if (prefix.endsWith("�")) prefix = prefix.slice(0, -1);
  const marker: TruncatedResult = { $truncated: { original_bytes: bytes, kept_bytes: Buffer.byteLength(prefix, "utf8") }, prefix };
  return JSON.stringify(marker);
}

/**
 * Hash of the effective (parsed, defaults applied, paths resolved) config object. Identifies
 * "what was in force" for this process; it is NOT stable across checkouts or key reorderings.
 */
export function configHash(config: unknown): string {
  return sha256Hex(JSON.stringify(config));
}

export class Ledger {
  private readonly db: Database.Database;
  private readonly now: () => string;
  private readonly maxResultBytes: number;
  /**
   * Chain tail per session: hash of the last CLOSED effect (or genesis). Kept in memory because
   * "last closed" cannot be recovered from the rows alone (ts_end ties within a millisecond,
   * clock steps) and this instance is the only writer for the sessions it opened —
   * better-sqlite3 is synchronous and a session never outlives its process.
   */
  private readonly tails = new Map<string, string>();

  constructor(path: string, opts: LedgerOptions = {}) {
    if (opts.readonly) {
      if (!existsSync(path)) throw new LedgerNotFoundError(`No ledger at ${path} — run \`sagaz serve\` first`);
      // Never writes rows. SQLite may still create the -wal/-shm sidecars a WAL reader needs.
      this.db = new Database(path, { readonly: true });
    } else {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(SCHEMA_V1);
    }
    this.db.pragma("foreign_keys = ON");
    this.now = opts.clock ?? (() => new Date().toISOString());
    this.maxResultBytes = opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  }

  close(): void {
    this.db.close();
  }

  // ---- sessions ------------------------------------------------------------

  openSession(input: { clientInfo?: unknown; configHash?: string | undefined }): SessionRow {
    const id = ulid();
    const row: SessionRow = {
      id,
      started_at: this.now(),
      client_info: input.clientInfo === undefined ? null : JSON.stringify(input.clientInfo),
      config_hash: input.configHash ?? null,
      genesis_hash: genesisHash(id),
    };
    this.db
      .prepare("INSERT INTO sessions (id, started_at, client_info, config_hash, genesis_hash) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.started_at, row.client_info, row.config_hash, row.genesis_hash);
    this.tails.set(row.id, row.genesis_hash);
    return row;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY id").all() as SessionRow[];
  }

  /** Most recent session (ULIDs sort by creation time). */
  lastSession(): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").get() as SessionRow | undefined;
  }

  /** Sessions whose id equals `ref` or starts with it (exact match wins). Plain prefix, no wildcards. */
  findSessions(ref: string): SessionRow[] {
    const exact = this.getSession(ref);
    if (exact) return [exact];
    return this.db.prepare("SELECT * FROM sessions WHERE substr(id, 1, length(?)) = ? ORDER BY id").all(ref, ref) as SessionRow[];
  }

  listSessionSummaries(): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT s.*, COUNT(e.id) AS effects,
                SUM(CASE WHEN e.status = 'pending' THEN 1 ELSE 0 END) AS pending,
                MAX(COALESCE(e.ts_end, e.ts_start)) AS last_ts
         FROM sessions s LEFT JOIN effects e ON e.session_id = s.id
         GROUP BY s.id ORDER BY s.id`,
      )
      .all() as SessionSummary[];
  }

  // ---- effects ---------------------------------------------------------------

  /** Records the call before it is forwarded. Returns the effect id. */
  begin(input: BeginEffectInput): string {
    const id = ulid();
    const insert = this.db.transaction(() => {
      const { seq } = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM effects WHERE session_id = ?")
        .get(input.sessionId) as { seq: number };
      this.db
        .prepare(
          `INSERT INTO effects (id, session_id, seq, ts_start, server, tool, args_json, status,
                                class, class_source, class_reason, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          id, input.sessionId, seq, this.now(), input.server, input.tool, JSON.stringify(input.args ?? {}),
          input.classification?.class ?? null, input.classification?.source ?? null, input.classification?.reason ?? null,
          PENDING_HASH, PENDING_HASH,
        );
    });
    insert();
    return id;
  }

  /** Closes the effect: stores the outcome, then hashes and chains it. */
  end(id: string, input: EndEffectInput): EffectRow {
    const close = this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Effect ${id} not found`);
      if (current.status !== "pending") throw new Error(`Effect ${id} already closed (${current.status})`);
      const resultJson = input.result === undefined ? null : truncateJson(JSON.stringify(input.result), this.maxResultBytes);
      const tsEnd = this.now();
      const prevHash = this.tail(current.session_id);
      const hashable: HashableEffect = { ...current, ts_end: tsEnd, result_json: resultJson, status: input.status };
      const hash = effectHash(prevHash, hashable);
      this.db
        .prepare("UPDATE effects SET ts_end = ?, result_json = ?, status = ?, prev_hash = ?, hash = ? WHERE id = ?")
        .run(tsEnd, resultJson, input.status, prevHash, hash, id);
      this.tails.set(current.session_id, hash);
      return this.get(id) as EffectRow;
    });
    return close();
  }

  get(id: string): EffectRow | undefined {
    return this.db.prepare("SELECT * FROM effects WHERE id = ?").get(id) as EffectRow | undefined;
  }

  listEffects(sessionId: string, filter: EffectFilter = {}): EffectRow[] {
    const where = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (filter.tool !== undefined) {
      where.push("tool = ?");
      params.push(filter.tool);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    return this.db.prepare(`SELECT * FROM effects WHERE ${where.join(" AND ")} ORDER BY seq`).all(...params) as EffectRow[];
  }

  /**
   * Current chain tail of a session. Only sessions opened by this instance can be appended to.
   *
   * Why the two branches below: a session missing from `tails` was not opened here, so the
   * caller is either a test driving a pre-existing session or another process trying to extend
   * one. If nothing was ever closed, the tail is unambiguous (genesis) and adopting it is safe.
   * If something was closed we deliberately do NOT re-derive the tail from the rows (verify
   * could): the invariant is one writer per chain, and a second appender — even with the right
   * tail — could race the first and fork it. So we refuse.
   */
  private tail(sessionId: string): string {
    const tail = this.tails.get(sessionId);
    if (tail !== undefined) return tail;
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const closed = this.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE session_id = ? AND status != 'pending'").get(sessionId) as { n: number };
    if (closed.n > 0) throw new Error(`Session ${sessionId} was opened by another process; its chain cannot be extended here`);
    this.tails.set(sessionId, session.genesis_hash);
    return session.genesis_hash;
  }

  /**
   * Walks the chain of a session by following prev_hash links from genesis and recomputes
   * every hash. Returns the ordered chain or the first broken link.
   */
  verifySession(sessionId: string): { ok: true; chain: EffectRow[] } | { ok: false; reason: string; chain: EffectRow[] } {
    const session = this.getSession(sessionId);
    if (!session) return { ok: false, reason: `session ${sessionId} not found`, chain: [] };
    const all = this.listEffects(sessionId);
    for (const e of all) {
      const pending = e.status === "pending";
      const hashed = e.hash !== PENDING_HASH || e.prev_hash !== PENDING_HASH || e.ts_end !== null;
      if (pending && hashed) return { ok: false, reason: `seq ${e.seq} (${e.id}) is marked pending but carries a hash or ts_end`, chain: [] };
      if (!pending && !hashed) return { ok: false, reason: `seq ${e.seq} (${e.id}) is closed but has no hash`, chain: [] };
    }
    const closed = all.filter((e) => e.status !== "pending");
    const byPrev = new Map<string, EffectRow>();
    for (const e of closed) {
      if (byPrev.has(e.prev_hash)) return { ok: false, reason: `two effects claim prev_hash ${e.prev_hash}`, chain: [] };
      byPrev.set(e.prev_hash, e);
    }
    const chain: EffectRow[] = [];
    let cursor = session.genesis_hash;
    while (byPrev.has(cursor)) {
      const e = byPrev.get(cursor) as EffectRow;
      if (effectHash(e.prev_hash, e) !== e.hash) return { ok: false, reason: `hash mismatch at seq ${e.seq} (${e.id})`, chain };
      chain.push(e);
      cursor = e.hash;
    }
    if (chain.length !== closed.length) return { ok: false, reason: `${closed.length - chain.length} closed effect(s) unreachable from genesis`, chain };
    return { ok: true, chain };
  }
}
