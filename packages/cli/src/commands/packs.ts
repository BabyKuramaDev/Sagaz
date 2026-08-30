/**
 * `sagaz packs` — the loaded compensation packs and what they cover downstream.
 *
 * Connects to the configured servers (same transports as `sagaz serve`), lists their tools and
 * classifies each with the full cascade. The "not covered" section is deliberately the user's
 * to-do list: every mutating tool without a pack entry, with its class explaining what kind of
 * work (an inverse, a rule, or accepting C/I) would close it. Collisions between packs fail
 * here exactly as they fail `sagaz serve` — this command exists to see them, not to hide them.
 */
import { assertNoPackCollisions, classify, loadConfig, matchPack, probeDownstreamTools, withoutCaptureEntries, type CompensationPack } from "sagaz-core";
import type { Parsed } from "../args.js";
import { table, type Style } from "../format.js";
import type { CommandIO } from "./context.js";

export async function packsCommand(_parsed: Parsed, configPath: string, io: CommandIO): Promise<number> {
  const { style } = io;
  const config = await loadConfig(configPath);
  const packs = config.packs;

  if (packs.length === 0) {
    io.out(style.yellow("no compensation packs loaded") + style.dim(` — add "packs": [...] (inline packs or paths to pack .json files) to ${configPath}`));
  } else {
    io.out(`${style.bold(String(packs.length))} pack(s) loaded${config.capture ? "" : ` — ${style.red('"capture": false')}: entries that declare a capture read are inert; result-derived inverses stay active`}`);
    for (const pack of packs) printPack(pack, io);
  }

  const toolsByServer = await probeDownstreamTools(config);
  const activePacks = config.capture ? packs : withoutCaptureEntries(packs);
  assertNoPackCollisions(activePacks, toolsByServer);

  io.out("");
  io.out(style.bold("downstream coverage"));
  for (const [server, tools] of toolsByServer) {
    const covered: string[][] = [];
    const uncovered: string[][] = [];
    const reads: string[] = [];
    for (const tool of tools) {
      const c = classify({ tool: tool.name, server, annotations: tool.annotations, rules: config.rules, packs: activePacks });
      const match = matchPack(activePacks, tool.name, server);
      if (match) {
        covered.push([tool.name, classCell(c.class, style), `${match.pack.name} → ${match.entry.inverse.tool}${match.entry.capture ? ` (captures ${match.entry.capture.tool})` : ""}`]);
      } else if (c.class === "read") {
        reads.push(tool.name);
      } else {
        uncovered.push([tool.name, classCell(c.class, style), c.reason]);
      }
    }
    io.out("");
    io.out(`server ${style.bold(server)} — ${tools.length} tool(s)`);
    if (covered.length > 0) {
      io.out(`  ${style.green(`covered by a pack (${covered.length})`)} — a deterministic inverse is planned on every call:`);
      io.out(indent(table([{ header: "tool" }, { header: "class" }, { header: "inverse" }], covered, style)));
    }
    if (uncovered.length > 0) {
      io.out(`  ${style.yellow(`not covered (${uncovered.length})`)} — your to-do list: a pack entry, a rule, or accepting that it is C/I:`);
      io.out(indent(table([{ header: "tool" }, { header: "class" }, { header: "why" }], uncovered, style)));
    }
    if (reads.length > 0) io.out(`  ${style.dim(`reads, nothing to undo (${reads.length}): ${reads.sort().join(", ")}`)}`);
  }
  return 0;
}

function printPack(pack: CompensationPack, io: CommandIO): void {
  const { style } = io;
  io.out("");
  io.out(`pack ${style.bold(pack.name)} ${style.dim(`— ${pack.description}`)}`);
  for (const entry of pack.entries) {
    const scope = entry.server ? `${entry.server}/${entry.tool}` : entry.tool;
    const capture = entry.capture ? ` ${style.dim(`(captures ${entry.capture.tool} → pre-state)`)}` : "";
    io.out(`  ${scope}  →  ${entry.inverse.tool}${capture}`);
    if (entry.note) io.out(`      ${style.dim(`why: ${entry.note}`)}`);
  }
}

function classCell(cls: string, style: Style): string {
  if (cls === "read") return style.cyan(cls);
  if (cls === "unknown") return style.yellow(cls);
  return style.bold(cls);
}

function indent(block: string): string {
  return block.split("\n").map((l) => (l.length ? `    ${l}` : l)).join("\n");
}
