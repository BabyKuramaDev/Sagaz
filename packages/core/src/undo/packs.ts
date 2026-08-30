/**
 * Compensation packs (T10 mechanism + T11 format): the declarative `tool → inverse` map.
 *
 * A pack entry says, for one mutating tool: how to read the pre-state before the call runs
 * (`capture`, optional — the inverse of a delete needs the row before it dies) and how to build
 * the inverse call afterwards (`inverse`, args mapped from `$.args`, `$.result`, `$.pre_state`).
 * The proxy runs the capture read AFTER the gates (a blocked call captures nothing) and BEFORE
 * forwarding (afterwards the pre-state no longer exists); on a successful close it derives
 * `undo_json` and marks `undo_status = 'planned'`. See docs/T0-recon-y-schema.md §3.5–§3.6.
 *
 * Packs are written by users as JSON (inline in sagaz.config.json or as files); the strict
 * schema and its loader live in pack-format.ts. This module is the runtime: matching and
 * reference resolution.
 */
import { globToRegExp } from "../glob.js";

/** Reads the pre-state before the mutating call is forwarded. Args map from `$.args.*` only. */
export interface CaptureSpec {
  tool: string;
  args: Record<string, string>;
}

/** Builds the inverse call. Args map from `$.args.*`, `$.result.*` and `$.pre_state.*`. */
export interface InverseSpec {
  tool: string;
  args: Record<string, string>;
}

export interface PackEntry {
  /** Downstream tool name: exact, or a glob where `*` matches any run of characters. */
  tool: string;
  /** Restricts the entry to one downstream server; matches any when omitted. */
  server?: string | undefined;
  capture?: CaptureSpec | undefined;
  inverse: InverseSpec;
  /** Human note: why this is the inverse. Never interpreted; shown by `sagaz packs`. */
  note?: string | undefined;
}

/**
 * A compensation pack: a named collection of entries. `name` identifies the pack in
 * `sagaz packs`, in `class_reason` and in collision errors; `description` says what it covers.
 */
export interface CompensationPack {
  name: string;
  description: string;
  entries: PackEntry[];
}

/** undo_json of a planned deterministic inverse (T0 §3, v1 format). */
export interface UndoToolCall {
  kind: "tool_call";
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * undo_json when a pack matched but no plan could be made (capture failed, mapping
 * unresolvable). The effect stays `undo_status = 'none'`; this descriptor records why —
 * "cannot be undone, and here is the reason" instead of a silent shrug.
 */
export interface UndoNoPlan {
  kind: "no_plan";
  reason: string;
}

/** First entry whose tool (exact or glob) and server (when declared) match. */
export function matchPackEntry(entries: readonly PackEntry[], tool: string, server: string): PackEntry | undefined {
  return entries.find((e) => (e.server === undefined || e.server === server) && globToRegExp(e.tool).test(tool));
}

export interface PackMatch {
  pack: CompensationPack;
  entry: PackEntry;
}

/**
 * The entries still in force when the global `"capture": false` switch is on. The flag turns
 * off the CAPTURE, not the undo: an entry that derives its inverse without pre-state
 * (create → delete from the result) stays active; only entries that declare a capture read go
 * inert — their pre-state would never exist, so neither can their R. Packs left empty are dropped.
 */
export function withoutCaptureEntries(packs: readonly CompensationPack[]): CompensationPack[] {
  return packs
    .map((p) => ({ ...p, entries: p.entries.filter((e) => e.capture === undefined) }))
    .filter((p) => p.entries.length > 0);
}

/**
 * First matching entry across packs. WITHIN a pack, entry order is the author's and first match
 * wins (like classification rules); BETWEEN packs there is no defined order, so the proxy
 * refuses to start when two packs cover the same downstream tool (see assertNoPackCollisions
 * in proxy.ts) — by the time this runs, at most one pack can match.
 */
export function matchPack(packs: readonly CompensationPack[], tool: string, server: string): PackMatch | undefined {
  for (const pack of packs) {
    const entry = matchPackEntry(pack.entries, tool, server);
    if (entry) return { pack, entry };
  }
  return undefined;
}

export class PathError extends Error {
  override readonly name = "PathError";
}

/** What a `$.…` reference resolves against. `result` and `pre_state` are tool-result payloads. */
export interface ResolveScope {
  args: unknown;
  result?: unknown;
  pre_state?: unknown;
}

const REFERENCE = /^\$\.(args|result|pre_state)((?:\.[A-Za-z0-9_-]+)*)$/;

/**
 * Resolves `$.args.x`, `$.result.x.y`, `$.pre_state.x` (T0 §3.5 syntax). A missing ROOT is a
 * PathError (the pack asked for a pre-state that was never captured); a leaf that resolves to
 * `undefined` is returned as-is so the caller can drop the key (an optional arg that was never
 * given). `null` is a value — the inverse of clearing a field must be expressible.
 */
export function resolveReference(ref: string, scope: ResolveScope): unknown {
  const m = REFERENCE.exec(ref);
  if (!m) throw new PathError(`invalid reference "${ref}" — expected $.args.x, $.result.x or $.pre_state.x`);
  const root = m[1] as keyof ResolveScope;
  let value: unknown = scope[root];
  if (value === undefined) throw new PathError(`"${ref}" cannot be resolved: no ${root === "pre_state" ? "pre-state was captured" : `${root} payload`}`);
  for (const segment of (m[2] ?? "").split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object") throw new PathError(`"${ref}" cannot be resolved: "${segment}" reached a non-object`);
    value = (value as Record<string, unknown>)[segment];
    if (value === undefined) return undefined;
  }
  return value;
}

/** Applies an args mapping. Keys whose reference resolves to `undefined` are dropped. */
export function mapArgs(mapping: Record<string, string>, scope: ResolveScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(mapping)) {
    const value = resolveReference(ref, scope);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The structured payload of a CallToolResult: `structuredContent` when the server provides it,
 * else the first text content block parsed as JSON, else undefined. `$.result` / `$.pre_state`
 * references resolve against this, not against the MCP envelope.
 */
export function payloadOf(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as { structuredContent?: unknown; content?: unknown };
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (!Array.isArray(r.content)) return undefined;
  const text = (r.content as Array<{ type?: string; text?: string }>).find((c) => c?.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
