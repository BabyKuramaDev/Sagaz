import type { EffectRow, EffectStatus, GateMeta } from "sagaz-core";
import { previewMeta, wouldHaveCell } from "./preview-report.js";
import { UsageError, type Parsed } from "../args.js";
import { formatBytes, formatDuration, formatTime, shortId, table, type Style } from "../format.js";
import { clientLabel, openReadonlyLedger, requireSession, type CommandIO } from "./context.js";

const STATUSES: EffectStatus[] = ["pending", "ok", "error", "blocked", "dry"];

export async function ledgerCommand(parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const statusFlag = parsed.flags["status"];
  if (typeof statusFlag === "string" && !STATUSES.includes(statusFlag as EffectStatus)) {
    throw new UsageError(`--status must be one of ${STATUSES.join(", ")}`);
  }
  const ledger = await openReadonlyLedger(configPath);
  try {
    const session = requireSession(ledger, String(parsed.flags["session"] ?? "last"));
    const rows = ledger.listEffects(session.id, {
      tool: typeof parsed.flags["tool"] === "string" ? parsed.flags["tool"] : undefined,
      status: typeof statusFlag === "string" ? (statusFlag as EffectStatus) : undefined,
    });

    if (parsed.flags["json"]) {
      for (const r of rows) io.out(JSON.stringify(r));
      return 0;
    }

    const { style } = io;
    io.out(`${style.bold("session")} ${session.id}  ${style.dim(`(${formatTime(session.started_at)}, ${clientLabel(session.client_info)})`)}`);
    if (rows.length === 0) {
      io.out(style.dim("no effects match"));
      return 0;
    }
    // The gate, undo and preview columns only appear when some row has something to say: the common case stays narrow.
    const gated = rows.some((r) => r.status === "blocked");
    const dry = rows.some((r) => r.status === "dry");
    const undo = rows.some((r) => r.undo_status !== "none" || r.undo_json !== null);
    io.out(
      table(
        [
          { header: "seq", align: "right" }, { header: "tool" }, { header: "server" }, { header: "class" },
          { header: "status" }, { header: "duration", align: "right" }, { header: "result", align: "right" }, { header: "id" },
          ...(undo ? [{ header: "undo" }] : []),
          ...(gated ? [{ header: "gate" }] : []),
          ...(dry ? [{ header: "preview" }] : []),
        ],
        rows.map((r) => [
          String(r.seq), r.tool, r.server, classCell(r, style), statusCell(r.status, style),
          formatDuration(r.ts_start, r.ts_end), formatBytes(r.result_json === null ? null : Buffer.byteLength(r.result_json)), style.dim(shortId(r.id)),
          ...(undo ? [undoCell(r, style)] : []),
          ...(gated ? [r.status === "blocked" ? style.red(gateReason(r)) : ""] : []),
          ...(dry ? [r.status === "dry" ? previewNote(r, style) : ""] : []),
        ]),
        style,
      ),
    );
    io.out(style.dim(`${rows.length} effect(s)${dry ? ` — ${rows.filter((r) => r.status === "dry").length} recorded dry, not executed (sagaz preview-report)` : ""}`));
    return 0;
  } finally {
    ledger.close();
  }
}

function classCell(r: EffectRow, style: Style): string {
  if (r.class === null) return style.dim("-");
  if (r.class === "read") return style.cyan("read");
  if (r.class === "unknown") return style.yellow("unknown");
  return style.bold(r.class);
}

/**
 * Minimal "has a plan" signal: the undo lifecycle status when there is one, or a dim
 * "no plan" when a pack matched but no inverse could be derived (undo_json holds the reason;
 * `sagaz ledger --json` shows it in full).
 */
function undoCell(r: EffectRow, style: Style): string {
  if (r.undo_status !== "none") return style.green(r.undo_status);
  if (r.undo_json !== null) return style.dim("no plan");
  return "";
}

function statusCell(status: string, style: Style): string {
  switch (status) {
    case "ok": return style.green("ok");
    case "error": return style.red("error");
    case "blocked": return style.red("blocked");
    case "pending": return style.yellow("pending");
    case "dry": return style.magenta("dry");
    default: return status;
  }
}

/** Why a blocked effect was stopped, from the gate metadata the proxy stored with the reply. */
export function gateReason(r: EffectRow): string {
  if (r.result_json === null) return "blocked";
  try {
    const meta = (JSON.parse(r.result_json) as { _meta?: { sagaz?: GateMeta } })._meta?.sagaz;
    if (!meta) return "blocked";
    const who =
      meta.gate === "denied" ? `denied by ${meta.decidedBy ?? "operator"}`
      : meta.gate === "timeout" ? "no answer in time"
      : meta.gate === "cancelled" ? "caller cancelled while held"
      : "blocked";
    return `${who} — ${meta.policy}`;
  } catch {
    return "blocked";
  }
}

/** What a dry effect would have done outside preview, from the metadata the proxy stored with the reply. */
function previewNote(r: EffectRow, style: Style): string {
  const meta = previewMeta(r);
  return `${style.magenta("not executed")} — ${wouldHaveCell(meta?.wouldHave ?? null, style)}`;
}
