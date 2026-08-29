import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToyboxServer } from "./server.js";
import { World, resolveDbPath } from "./world.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `sagaz-toybox — a deliberately dangerous MCP server simulating an external world

Usage:
  sagaz-toybox [serve]   Run the MCP server on stdio (default)
  sagaz-toybox seed      Reset the world and load deterministic sample data
  sagaz-toybox inspect   Print the full state of the world
  sagaz-toybox --version
  sagaz-toybox --help

State lives in a SQLite file: $TOYBOX_DB (default ./toybox.db).`;

async function main(argv: readonly string[]): Promise<number> {
  const [cmd] = argv;
  const dbPath = resolveDbPath();

  switch (cmd) {
    case "--version":
    case "-v":
      process.stdout.write(`sagaz-toybox ${version}\n`);
      return 0;
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "seed": {
      const world = new World(dbPath);
      world.seed();
      world.close();
      process.stdout.write(`Seeded ${dbPath}\n`);
      return 0;
    }
    case "inspect": {
      const world = new World(dbPath);
      process.stdout.write(`World: ${dbPath}\n${world.inspect()}`);
      world.close();
      return 0;
    }
    case undefined:
    case "serve": {
      const world = new World(dbPath);
      const server = createToyboxServer(world, { version });
      // stdout is the MCP channel: anything human goes to stderr.
      process.stderr.write(`sagaz-toybox ${version} serving on stdio (db: ${dbPath})\n`);
      await server.connect(new StdioServerTransport());
      const shutdown = () => {
        world.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.stdin.on("close", shutdown);
      return -1; // keep running
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}\n`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
