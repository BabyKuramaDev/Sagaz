import { CORE_VERSION } from "@sagaz/core";
import { CLI_VERSION } from "./version.js";

const USAGE = `sagaz — effect ledger and undo for AI agents

Usage:
  sagaz --version    Print version and exit
  sagaz --help       Show this help

Phase 0 scaffold: no commands yet.`;

export function run(argv: readonly string[]): { code: number; out: string } {
  const [arg] = argv;
  switch (arg) {
    case "--version":
    case "-v":
      return { code: 0, out: `sagaz ${CLI_VERSION} (core ${CORE_VERSION})` };
    case "--help":
    case "-h":
    case undefined:
      return { code: 0, out: USAGE };
    default:
      return { code: 1, out: `Unknown argument: ${arg}\n\n${USAGE}` };
  }
}

const { code, out } = run(process.argv.slice(2));
(code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
process.exitCode = code;
