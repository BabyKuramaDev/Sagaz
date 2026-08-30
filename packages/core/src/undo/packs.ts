/**
 * Capture hook + undo plans (T10): the mechanism compensation packs run on.
 *
 * A pack entry says, for one mutating tool: how to read the pre-state before the call runs
 * (`capture`, optional — the inverse of a delete needs the row before it dies) and how to build
 * the inverse call afterwards (`inverse`, args mapped from `$.args`, `$.result`, `$.pre_state`).
 * The proxy runs the capture read AFTER the gates (a blocked call captures nothing) and BEFORE
 * forwarding (afterwards the pre-state no longer exists); on a successful close it derives
 * `undo_json` and marks `undo_status = 'planned'`. See docs/T0-recon-y-schema.md §3.5–§3.6.
 *
 * INTERNAL / PROVISIONAL data: `TOYBOX_TEST_PACK` below is a hardcoded stand-in that exercises
 * the mechanism against the toybox until T11 ships the declarative JSON pack format and its
 * loader (`"packs"` in sagaz.config.json, glob matching, the official toybox pack file). The
 * mechanism stays; where entries come from is what T11 replaces.
 */

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
  /** Downstream tool name, exact match (globs arrive with T11's real format). */
  tool: string;
  /** Restricts the entry to one downstream server; matches any when omitted. */
  server?: string;
  capture?: CaptureSpec;
  inverse: InverseSpec;
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

/** First entry whose tool (and server, when declared) matches. */
export function matchPackEntry(entries: readonly PackEntry[], tool: string, server: string): PackEntry | undefined {
  return entries.find((e) => (e.server === undefined || e.server === server) && e.tool === tool);
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

/**
 * INTERNAL / PROVISIONAL (see module comment): minimal toybox entries to exercise the
 * mechanism end to end — an inverse derived from the result alone (create_contact) and one
 * that needs the pre-state captured before the row dies (delete_contact). Replaced by the
 * official toybox pack file in T11.
 */
export const TOYBOX_TEST_PACK: readonly PackEntry[] = [
  {
    tool: "create_contact",
    inverse: { tool: "delete_contact", args: { id: "$.result.id" } },
  },
  {
    tool: "delete_contact",
    capture: { tool: "get_contact", args: { id: "$.args.id" } },
    inverse: {
      tool: "create_contact",
      args: { name: "$.pre_state.name", email: "$.pre_state.email", company: "$.pre_state.company" },
    },
  },
];
