import { Ledger, LedgerNotFoundError, loadConfig } from "sagaz-core";
import type { Parsed } from "../args.js";
import { formatTime, table } from "../format.js";
import { clientLabel, positiveInt, type CommandIO } from "./context.js";

const DEFAULT_LAST = 5;

export async function statusCommand(parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const { style } = io;
  const config = await loadConfig(configPath);
  const servers = Object.entries(config.servers);
  io.out(style.bold("sagaz status"));
  io.out(`  config   ${configPath}`);
  io.out(`  servers  ${servers.map(([n, s]) => `${n}${s.prefix ? ` (prefix ${s.prefix}__)` : ""}`).join(", ")}`);
  io.out(`  ledger   ${config.ledger.path}`);

  let ledger: Ledger;
  try {
    ledger = new Ledger(config.ledger.path, { readonly: true });
  } catch (err) {
    if (err instanceof LedgerNotFoundError) {
      io.out(`  state    ${style.yellow("no ledger yet")} ${style.dim("(nothing has run through sagaz serve)")}`);
      return 0;
    }
    throw err;
  }
  try {
    const summaries = ledger.listSessionSummaries();
    const effects = summaries.reduce((n, s) => n + s.effects, 0);
    const pending = summaries.reduce((n, s) => n + s.pending, 0);
    const held = ledger.listPendingApprovals().length;
    io.out(
      `  state    ${summaries.length} session(s), ${effects} effect(s)${pending ? `, ${style.yellow(`${pending} pending`)}` : ""}` +
        (held ? `, ${style.yellow(`${held} waiting for approval`)} ${style.dim("(sagaz pending)")}` : ""),
    );
    if (summaries.length === 0) return 0;

    const n = positiveInt("last", parsed.flags["last"], DEFAULT_LAST);
    const shown = summaries.slice(-n);
    io.out("");
    io.out(style.bold(`last ${shown.length} session(s)`));
    io.out(
      table(
        [{ header: "session" }, { header: "started" }, { header: "client" }, { header: "effects", align: "right" }, { header: "last activity" }],
        shown.map((s) => [
          s.id,
          formatTime(s.started_at),
          clientLabel(s.client_info),
          s.pending ? `${s.effects} ${style.yellow(`(${s.pending} pending)`)}` : String(s.effects),
          s.last_ts ? formatTime(s.last_ts) : style.dim("-"),
        ]),
        style,
      ),
    );
    return 0;
  } finally {
    ledger.close();
  }
}
