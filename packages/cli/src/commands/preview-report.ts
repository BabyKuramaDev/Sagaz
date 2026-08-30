import type { EffectRow, PolicyAction, PreviewMeta } from "sagaz-core";
import type { Parsed } from "../args.js";
import { formatTime, table, type Style } from "../format.js";
import { summarizeArgs } from "./pending.js";
import { clientLabel, openReadonlyLedger, requireSession, type CommandIO } from "./context.js";

/**
 * `sagaz preview-report`: what a dry session would have done to the world. Groups the 'dry'
 * effects by class, says what the policy would have done with each, and lists them in order.
 * This is the story a preview exists to tell.
 */
export async function previewReportCommand(parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const ledger = await openReadonlyLedger(configPath);
  try {
    const session = requireSession(ledger, String(parsed.flags["session"] ?? "last"));
    const rows = ledger.listEffects(session.id);
    const report = buildPreviewReport(rows);
    if (parsed.flags["json"]) {
      io.out(JSON.stringify({ session: session.id, ...report }));
      return 0;
    }
    const { style } = io;
    io.out(`${style.bold("preview report")} — session ${session.id}  ${style.dim(`(${formatTime(session.started_at)}, ${clientLabel(session.client_info)})`)}`);
    if (report.dry.length === 0) {
      io.out(style.dim(rows.length === 0 ? "no effects in this session" : "nothing ran dry in this session — was it started with `sagaz serve --preview`?"));
      return 0;
    }
    io.out(
      `Nothing reached the world. ${rows.length} call(s): ${report.reads} read(s) executed, ${style.magenta(`${report.dry.length} recorded dry`)}` +
        (report.other ? style.dim(` (${report.other} other)`) : "") + ".",
    );
    io.out("");
    io.out(style.bold("what would have happened"));
    for (const g of report.groups) {
      const tools = g.tools.map((t) => (t.count > 1 ? `${t.tool} ×${t.count}` : t.tool)).join(", ");
      io.out(`  ${classCell(g.class.padEnd(LABEL_WIDTH), style)}${String(g.count).padStart(3)}  ${tools}`);
      io.out(`  ${" ".repeat(LABEL_WIDTH + 5)}${style.dim(`${CLASS_MEANING[g.class]}; ${g.wouldHave.map((w) => describe(w.action, w.count, g.count)).join(", ")}`)}`);
    }
    io.out("");
    io.out(
      table(
        [{ header: "seq", align: "right" }, { header: "tool" }, { header: "server" }, { header: "class" }, { header: "outside preview" }, { header: "args" }],
        report.dry.map((d) => [String(d.seq), d.tool, d.server, classCell(d.class, style), wouldHaveCell(d.wouldHave, style), summarizeArgs(d.args_json)]),
        style,
      ),
    );
    return 0;
  } finally {
    ledger.close();
  }
}

export type DryClass = "R" | "C" | "I" | "unknown";

export interface DryEffect {
  seq: number;
  tool: string;
  server: string;
  class: DryClass;
  /** Absent when the row carries no preview metadata (should not happen for rows the proxy wrote). */
  wouldHave: PolicyAction | null;
  args_json: string;
}

export interface PreviewGroup {
  class: DryClass;
  count: number;
  tools: { tool: string; count: number }[];
  wouldHave: { action: PolicyAction | null; count: number }[];
}

export interface PreviewReport {
  reads: number;
  /** Effects that are neither reads nor dry (ok/error/blocked/pending): a mixed or non-preview session. */
  other: number;
  dry: DryEffect[];
  groups: PreviewGroup[];
}

const CLASS_ORDER: DryClass[] = ["I", "C", "R", "unknown"];
const LABEL_WIDTH = "unknown".length;

const CLASS_MEANING: Record<DryClass, string> = {
  I: "irreversible: no way back once executed",
  C: "compensable: cannot be undone, only corrected afterwards",
  R: "reversible: a deterministic inverse exists",
  unknown: "reversibility unknown: no rule, annotation or heuristic decided",
};

/** Pure: the report from a session's rows, in seq order. */
export function buildPreviewReport(rows: EffectRow[]): PreviewReport {
  let reads = 0;
  let other = 0;
  const dry: DryEffect[] = [];
  for (const r of rows) {
    if (r.status === "dry") {
      const cls = (r.class === "R" || r.class === "C" || r.class === "I" ? r.class : "unknown") as DryClass;
      dry.push({ seq: r.seq, tool: r.tool, server: r.server, class: cls, wouldHave: previewMeta(r)?.wouldHave ?? null, args_json: r.args_json });
    } else if (r.class === "read") reads++;
    else other++;
  }
  const groups: PreviewGroup[] = [];
  for (const cls of CLASS_ORDER) {
    const members = dry.filter((d) => d.class === cls);
    if (members.length === 0) continue;
    groups.push({ class: cls, count: members.length, tools: tally(members, (d) => d.tool).map(([tool, count]) => ({ tool, count })), wouldHave: tally(members, (d) => d.wouldHave).map(([action, count]) => ({ action, count })) });
  }
  return { reads, other, dry, groups };
}

function tally<T, K>(items: T[], key: (item: T) => K): [K, number][] {
  const m = new Map<K, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()];
}

/** The metadata the proxy stored with the dry reply, if the row has one. */
export function previewMeta(r: EffectRow): PreviewMeta | undefined {
  if (r.result_json === null) return undefined;
  try {
    const meta = (JSON.parse(r.result_json) as { _meta?: { sagaz?: { preview?: boolean } } })._meta?.sagaz;
    return meta?.preview === true ? (meta as PreviewMeta) : undefined;
  } catch {
    return undefined;
  }
}

function describe(action: PolicyAction | null, n: number, total: number): string {
  const who = total > 1 ? (n === total ? "all" : `${n} of them`) : "it";
  switch (action) {
    case "allow": return `${who} would have run without asking`;
    case "confirm": return `${who} would have waited for your approval`;
    case "block": return `${who} would have been blocked by policy`;
    default: return `${who} carried no policy verdict`;
  }
}

function classCell(cls: string, style: Style): string {
  return cls.trim() === "unknown" ? style.yellow(cls) : style.bold(cls);
}

export function wouldHaveCell(action: PolicyAction | null, style: Style): string {
  switch (action) {
    case "allow": return "would run";
    case "confirm": return style.yellow("would wait for approval");
    case "block": return style.red("would be blocked");
    default: return style.dim("-");
  }
}
