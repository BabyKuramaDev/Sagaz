import { userInfo } from "node:os";
import { ApprovalError, type ApprovalDecision, type ApprovalRow } from "sagaz-core";
import { UsageError, type Parsed } from "../args.js";
import { shortId } from "../format.js";
import { LookupError, openWritableLedger, type CommandIO } from "./context.js";

/** `sagaz approve <id>` / `sagaz deny <id>` — <id> is the effect id as shown by `sagaz pending` (full or last 8 chars). */
export async function decideCommand(decision: ApprovalDecision, parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const verb = decision === "allow" ? "approve" : "deny";
  const ref = parsed.positional[1];
  if (ref === undefined) throw new UsageError(`sagaz ${verb} needs the id of a held call (see \`sagaz pending\`)`);
  if (parsed.positional.length > 2) throw new UsageError(`Unexpected argument: ${parsed.positional[2]}`);
  const by = typeof parsed.flags["by"] === "string" && parsed.flags["by"].trim() !== "" ? parsed.flags["by"].trim() : operatorName();

  const ledger = await openWritableLedger(configPath);
  try {
    const matches = ledger.findApprovalsByEffect(ref);
    if (matches.length === 0) throw new LookupError(`No held call matches "${ref}" (see \`sagaz pending\`)`);
    if (matches.length > 1) throw new LookupError(`"${ref}" is ambiguous: ${matches.map((m) => m.effect_id).join(", ")}`);
    const approval = matches[0] as ApprovalRow;
    const effect = ledger.get(approval.effect_id);
    let decided: ApprovalRow;
    try {
      decided = ledger.decide(approval.id, decision, by);
    } catch (err) {
      if (err instanceof ApprovalError) throw new LookupError(`${effect?.tool ?? approval.effect_id} ${shortId(approval.effect_id)}: ${err.message}`);
      throw err;
    }
    const { style } = io;
    const label = decision === "allow" ? style.green("approved") : style.red("denied");
    io.out(`${label} ${style.bold(effect?.tool ?? "?")} ${style.dim(shortId(decided.effect_id))} by ${by}`);
    return 0;
  } finally {
    ledger.close();
  }
}

function operatorName(): string {
  try {
    return userInfo().username;
  } catch {
    return "operator";
  }
}
