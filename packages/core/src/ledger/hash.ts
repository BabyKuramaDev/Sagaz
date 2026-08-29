/**
 * Hash chain for the effect ledger.
 *
 * ## Canonical serialization (v1) — the contract `sagaz verify` depends on
 *
 * Each closed effect is hashed as
 *
 *     hash = hex( sha256( utf8(prev_hash) || utf8(canonical) ) )
 *
 * where `||` is byte concatenation with NO separator and `canonical` is the JSON text of the
 * object below, produced with:
 *
 *   - exactly these 12 keys, in this (ASCII-sorted) order, all always present:
 *       args_json, class, id, pre_state_json, result_json, seq, server, session_id,
 *       status, tool, ts_end, ts_start
 *   - no whitespace anywhere (JSON.stringify without indentation)
 *   - `null` for SQL NULL (class, pre_state_json, result_json, ts_end may be null)
 *   - `seq` as a JSON number; every other field as a JSON string, escaped per RFC 8259 by
 *     JSON.stringify (so `"` → `\"`, control chars → `\uXXXX`, lone surrogates → `\uXXXX`
 *     (well-formed JSON.stringify), other non-ASCII left as UTF-8)
 *   - args_json / result_json / pre_state_json are hashed AS STORED — they are JSON *text*
 *     columns and appear as JSON strings inside the canonical object; they are never
 *     re-parsed or re-serialized. Truncated results are therefore hashed truncated.
 *   - `class` is the value at closing time (the classifier may only set it before close)
 *
 * The hash covers only immutable columns; the undo lifecycle columns (undo_json,
 * undo_status, compensates_id, checkpoint_id) are excluded so later mutations of those
 * never invalidate the chain (a compensation is its own hashed row).
 *
 * `prev_hash` is the hash of the previously CLOSED effect of the same session, or the
 * session's `genesis_hash` for the first closed effect. Chaining follows closing order (not
 * `seq`) because tool calls can run concurrently and close out of order; `seq` is inside the
 * payload, so emission order is still tamper-evident. Pending (never closed) effects carry
 * prev_hash = hash = '' and are outside the chain — an honest record of a crash.
 *
 * `genesis_hash` = hex(sha256(utf8("sagaz-genesis:" || session_id))).
 */
import { createHash } from "node:crypto";

export interface HashableEffect {
  id: string;
  session_id: string;
  seq: number;
  ts_start: string;
  ts_end: string | null;
  server: string;
  tool: string;
  args_json: string;
  pre_state_json: string | null;
  result_json: string | null;
  status: string;
  class: string | null;
}

export const CANONICAL_KEYS = [
  "args_json", "class", "id", "pre_state_json", "result_json", "seq",
  "server", "session_id", "status", "tool", "ts_end", "ts_start",
] as const;

export function canonicalize(e: HashableEffect): string {
  const ordered: Record<string, string | number | null> = {};
  for (const k of CANONICAL_KEYS) ordered[k] = e[k];
  return JSON.stringify(ordered);
}

export function sha256Hex(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p, "utf8");
  return h.digest("hex");
}

export function effectHash(prevHash: string, e: HashableEffect): string {
  return sha256Hex(prevHash, canonicalize(e));
}

export function genesisHash(sessionId: string): string {
  return sha256Hex(`sagaz-genesis:${sessionId}`);
}
