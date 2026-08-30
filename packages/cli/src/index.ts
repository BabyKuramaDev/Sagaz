import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CORE_VERSION, ConfigError, DEFAULT_CONFIG_PATH, Ledger, LedgerNotFoundError, SagazProxy, ToolCollisionError, loadConfig } from "sagaz-core";
import { UsageError, parseFlags } from "./args.js";
import { LookupError, type CommandIO } from "./commands/context.js";
import { decideCommand } from "./commands/approve.js";
import { ledgerCommand } from "./commands/ledger.js";
import { pendingCommand } from "./commands/pending.js";
import { previewReportCommand } from "./commands/preview-report.js";
import { statusCommand } from "./commands/status.js";
import { verifyCommand } from "./commands/verify.js";
import { colourEnabled, makeStyle } from "./format.js";
import { CLI_VERSION } from "./version.js";

const USAGE = `sagaz — effect ledger and undo for AI agents

Usage:
  sagaz serve [--preview]             Run the MCP proxy on stdio (--preview: run the session dry)
  sagaz ledger [filters]              Effects of a session (default: last)
      --session <id|last>  --tool <name>  --status <pending|ok|error|blocked|dry>  --json
  sagaz status [--last <n>]           Sessions, ledger location, overall state
  sagaz verify [--session <id|last>]  Walk the hash chain and report OK or the first break
  sagaz pending                       Calls held by a confirm gate, waiting for you
  sagaz approve <id> [--by <name>]    Let a held call through
  sagaz deny <id> [--by <name>]       Refuse a held call (the agent is told, nothing runs)
  sagaz preview-report [--session]    What a dry session would have done to the world (--json)

Options:
  --config <path>                     sagaz.config.json to use (default: ${DEFAULT_CONFIG_PATH})
  --version, --help`;

const VALUE_FLAGS = ["config", "session", "tool", "status", "last", "by"] as const;
const WITH_ARG = new Set(["approve", "deny"]);
const SHORT: Record<string, string> = { "-v": "--version", "-h": "--help", "-c": "--config" };

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv.map((a) => SHORT[a] ?? a), VALUE_FLAGS);
  const configPath = typeof parsed.flags["config"] === "string" ? parsed.flags["config"] : DEFAULT_CONFIG_PATH;
  const [cmd, ...extra] = parsed.positional;
  if (extra.length && !WITH_ARG.has(cmd ?? "")) throw new UsageError(`Unexpected argument: ${extra[0]}`);

  if (parsed.flags["version"] || cmd === "version") {
    process.stdout.write(`sagaz ${CLI_VERSION} (core ${CORE_VERSION})\n`);
    return 0;
  }
  if (parsed.flags["help"] || cmd === undefined || cmd === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const io: CommandIO = { out: (s) => process.stdout.write(`${s}\n`), style: makeStyle(colourEnabled()) };

  switch (cmd) {
    case "ledger":
      return ledgerCommand(parsed, configPath, io);
    case "status":
      return statusCommand(parsed, configPath, io);
    case "verify":
      return verifyCommand(parsed, configPath, io);
    case "pending":
      return pendingCommand(parsed, configPath, io);
    case "approve":
      return decideCommand("allow", parsed, configPath, io);
    case "deny":
      return decideCommand("deny", parsed, configPath, io);
    case "preview-report":
      return previewReportCommand(parsed, configPath, io);
    case "serve":
      return serve(configPath, parsed.flags["preview"] === true);
    default:
      throw new UsageError(`Unknown command: ${cmd}`);
  }
}

async function serve(configPath: string, preview: boolean): Promise<number> {
  // stdout is the MCP channel from here on: anything human goes to stderr.
  const config = await loadConfig(configPath);
  const ledger = new Ledger(config.ledger.path, { maxResultBytes: config.ledger.maxResultBytes });
  process.stderr.write(`sagaz: ledger at ${config.ledger.path}\n`);
  const proxy = new SagazProxy(config, { version: CLI_VERSION, ledger, preview });
  try {
    await proxy.start();
  } catch (err) {
    // Downstream processes may already be running: release them or the event loop never drains.
    await proxy.close();
    ledger.close();
    throw err;
  }
  await proxy.serve(new StdioServerTransport());
  const shutdown = () => {
    void proxy.close().finally(() => {
      ledger.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  return -1; // keep running
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`sagaz: ${err.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const known =
      err instanceof ConfigError || err instanceof ToolCollisionError || err instanceof LedgerNotFoundError || err instanceof LookupError ||
      (err instanceof Error && err.name === "SqliteError");
    process.stderr.write(`sagaz: ${known ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
