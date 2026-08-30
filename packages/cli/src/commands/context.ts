import { Ledger, LedgerNotFoundError, loadConfig, type SessionRow } from "sagaz-core";
import { UsageError } from "../args.js";
import type { Style } from "../format.js";

export interface CommandIO {
  out: (s: string) => void;
  style: Style;
}

export async function openReadonlyLedger(configPath: string): Promise<Ledger> {
  const config = await loadConfig(configPath);
  return new Ledger(config.ledger.path, { readonly: true });
}

/** `--session` semantics: "last" (default), a full id, or a unique prefix. */
export function requireSession(ledger: Ledger, ref: string): SessionRow {
  if (ref === "last") {
    const last = ledger.lastSession();
    if (!last) throw new LedgerNotFoundError("The ledger has no sessions yet — run an agent through `sagaz serve` first");
    return last;
  }
  const matches = ledger.findSessions(ref);
  if (matches.length === 1) return matches[0] as SessionRow;
  throw new LookupError(
    matches.length === 0
      ? `No session matches "${ref}" (use a full id, a unique prefix, or "last")`
      : `"${ref}" is ambiguous: ${matches.map((m) => m.id).join(", ")}`,
  );
}

/** A miss on user-supplied identifiers: reported as a one-line error, without the usage block. */
export class LookupError extends Error {
  override readonly name = "LookupError";
}

export function positiveInt(flag: string, value: string | true | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new UsageError(`--${flag} must be a positive integer`);
  return Number(value);
}

export function clientLabel(clientInfo: string | null): string {
  if (!clientInfo) return "-";
  const c = JSON.parse(clientInfo) as { name?: string; version?: string };
  return c.name ? `${c.name} ${c.version ?? ""}`.trimEnd() : "-";
}

/** For `approve` / `deny`: writes the approvals table only, never creates a ledger. */
export async function openWritableLedger(configPath: string): Promise<Ledger> {
  const config = await loadConfig(configPath);
  return new Ledger(config.ledger.path, { mustExist: true });
}
