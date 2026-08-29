import type { Parsed } from "../args.js";
import { formatWait, shortId, table } from "../format.js";
import { openWritableLedger, type CommandIO } from "./context.js";

/** Longest args preview in the table; the full args are in `sagaz ledger --json`. */
const ARGS_WIDTH = 48;

export async function pendingCommand(_parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const { style } = io;
  const ledger = await openWritableLedger(configPath);
  try {
    const rows = ledger.listPendingApprovals();
    if (rows.length === 0) {
      io.out(style.dim("nothing is waiting for approval"));
      return 0;
    }
    const now = new Date().toISOString();
    io.out(
      table(
        [{ header: "id" }, { header: "tool" }, { header: "server" }, { header: "class" }, { header: "args" }, { header: "waiting", align: "right" }],
        rows.map((r) => [
          style.bold(shortId(r.effect_id)), r.tool, r.server, r.class ?? "-", summarizeArgs(r.args_json), style.yellow(formatWait(r.requested_at, now)),
        ]),
        style,
      ),
    );
    io.out(style.dim(`${rows.length} call(s) held — sagaz approve <id> | sagaz deny <id>`));
    return 0;
  } finally {
    ledger.close();
  }
}

/** `key=value, key=value` on one line, cut at ARGS_WIDTH. */
export function summarizeArgs(argsJson: string): string {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return argsJson.slice(0, ARGS_WIDTH);
  }
  if (typeof args !== "object" || args === null) return String(args).slice(0, ARGS_WIDTH);
  const text = Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return text.length > ARGS_WIDTH ? `${text.slice(0, ARGS_WIDTH - 1)}…` : text;
}
