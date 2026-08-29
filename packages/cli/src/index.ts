import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CORE_VERSION, ConfigError, DEFAULT_CONFIG_PATH, SagazProxy, ToolCollisionError, loadConfig } from "@sagaz/core";
import { CLI_VERSION } from "./version.js";

const USAGE = `sagaz — effect ledger and undo for AI agents

Usage:
  sagaz serve [--config <path>]   Run the MCP proxy on stdio (default config: ${DEFAULT_CONFIG_PATH})
  sagaz --version                 Print version and exit
  sagaz --help                    Show this help`;

export interface ParsedArgs {
  command: "serve" | "version" | "help";
  config: string;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "--version":
    case "-v":
      return { command: "version", config: DEFAULT_CONFIG_PATH };
    case "--help":
    case "-h":
    case undefined:
      return { command: "help", config: DEFAULT_CONFIG_PATH };
    case "serve": {
      let config = DEFAULT_CONFIG_PATH;
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config" || flag === "-c") {
          const value = rest[++i];
          if (!value) return { command: "serve", config, error: "--config requires a path" };
          config = value;
        } else {
          return { command: "serve", config, error: `Unknown argument: ${flag}` };
        }
      }
      return { command: "serve", config };
    }
    default:
      return { command: "help", config: DEFAULT_CONFIG_PATH, error: `Unknown argument: ${cmd}` };
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 1;
  }
  switch (parsed.command) {
    case "version":
      process.stdout.write(`sagaz ${CLI_VERSION} (core ${CORE_VERSION})\n`);
      return 0;
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "serve": {
      // stdout is the MCP channel from here on: anything human goes to stderr.
      const config = await loadConfig(parsed.config);
      const proxy = new SagazProxy(config, { version: CLI_VERSION });
      try {
        await proxy.start();
      } catch (err) {
        // Downstream processes may already be running: release them or the event loop never drains.
        await proxy.close();
        throw err;
      }
      await proxy.serve(new StdioServerTransport());
      const shutdown = () => {
        void proxy.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.stdin.on("close", shutdown);
      return -1; // keep running
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    const known = err instanceof ConfigError || err instanceof ToolCollisionError;
    process.stderr.write(`sagaz: ${known ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
