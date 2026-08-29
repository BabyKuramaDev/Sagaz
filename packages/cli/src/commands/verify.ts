import type { Parsed } from "../args.js";
import { openReadonlyLedger, requireSession, type CommandIO } from "./context.js";

export async function verifyCommand(parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const { style } = io;
  const ledger = await openReadonlyLedger(configPath);
  try {
    const session = requireSession(ledger, String(parsed.flags["session"] ?? "last"));
    const pending = ledger.listEffects(session.id, { status: "pending" }).length;
    const result = ledger.verifySession(session.id);
    io.out(`${style.bold("verify")} session ${session.id}`);
    io.out(`  genesis  ${session.genesis_hash}`);
    const seqWidth = Math.max(3, ...result.chain.map((e) => String(e.seq).length));
    const toolWidth = Math.max(...result.chain.map((e) => e.tool.length), 0);
    for (const e of result.chain) {
      io.out(`  ${style.green("✓")} seq ${String(e.seq).padStart(seqWidth)}  ${e.tool.padEnd(toolWidth)}  ${style.dim(e.prev_hash.slice(0, 12))} → ${e.hash.slice(0, 12)}`);
    }
    if (result.ok) {
      io.out(`${style.green("OK")} ${result.chain.length} effect(s) chained${pending ? `, ${style.yellow(`${pending} pending (never closed)`)}` : ""}`);
      return 0;
    }
    io.out(`${style.red("BROKEN")} after ${result.chain.length} verified effect(s): ${result.reason}`);
    return 2;
  } finally {
    ledger.close();
  }
}
