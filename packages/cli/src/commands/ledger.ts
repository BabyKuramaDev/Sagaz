import type { EffectRow, EffectStatus, GateMeta } from "@sagaz/core";
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
    // The gate column only appears when something was stopped: the common case stays narrow.
    const gated = rows.some((r) => r.status === "blocked");
    io.out(
      table(
        [
          { header: "seq", align: "right" }, { header: "tool" }, { header: "server" }, { header: "class" },
          { header: "status" }, { header: "duration", align: "right" }, { header: "result", align: "right" }, { header: "id" },
          ...(gated ? [{ header: "gate" }] : []),
        ],
        rows.map((r) => [
          String(r.seq), r.tool, r.server, classCell(r, style), statusCell(r.status, style),
          formatDuration(r.ts_start, r.ts_end), formatBytes(r.result_json === null ? null : Buffer.byteLength(r.result_json)), style.dim(shortId(r.id)),
          ...(gated ? [r.status === "blocked" ? style.red(gateReason(r)) : ""] : []),
        ]),
        style,
      ),
    );
    io.out(style.dim(`${rows.length} effect(s)`));
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

function statusCell(status: string, style: Style): string {
  switch (status) {
    case "ok": return style.green("ok");
    case "error": return style.red("error");
    case "blocked": return style.red("blocked");
    case "pending": return style.yellow("pending");
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
