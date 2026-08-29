/**
 * sagaz.config.json — the proxy's view of the downstream MCP servers.
 *
 * Shape mirrors the `mcpServers` entries of an MCP client config so users can copy them over,
 * plus an optional, explicit `prefix` per server used to namespace its tools (`prefix__tool`).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_LEDGER_PATH, DEFAULT_MAX_RESULT_BYTES } from "./ledger/ledger.js";

export const DEFAULT_CONFIG_PATH = "./sagaz.config.json";

/** Separator between an explicit prefix and the downstream tool name. */
export const PREFIX_SEPARATOR = "__";

const IDENT = /^[A-Za-z0-9_-]+$/;

const ServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Working directory for the downstream process; relative to the config file. */
  cwd: z.string().optional(),
  /** Opt-in tool namespace: `prefix__tool`. Never applied automatically. */
  prefix: z.string().regex(IDENT, "prefix must match [A-Za-z0-9_-]+").optional(),
});

const LedgerConfigSchema = z.object({
  /** SQLite file for the effect ledger; relative to the config file. Directory is created. */
  path: z.string().min(1).default(DEFAULT_LEDGER_PATH),
  /** result_json larger than this is truncated (marked, see ledger/ledger.ts). */
  maxResultBytes: z.number().int().positive().default(DEFAULT_MAX_RESULT_BYTES),
});

/**
 * User classification rule — classifier level 1, always wins over annotations and heuristics.
 * `tool` is an exact downstream tool name or a glob where `*` matches any run of characters
 * (`delete_*`, `*_draft`). `server` narrows the rule to one downstream. First matching rule in
 * file order wins.
 */
const ClassificationRuleSchema = z.object({
  tool: z.string().min(1),
  server: z.string().regex(IDENT, "server must match [A-Za-z0-9_-]+").optional(),
  class: z.enum(["read", "R", "C", "I", "unknown"]),
  /** Stored as class_reason; defaults to a description of the rule. */
  reason: z.string().min(1).optional(),
});

const ConfigSchema = z.object({
  servers: z.record(z.string().regex(IDENT, "server name must match [A-Za-z0-9_-]+"), ServerConfigSchema),
  ledger: LedgerConfigSchema.default({ path: DEFAULT_LEDGER_PATH, maxResultBytes: DEFAULT_MAX_RESULT_BYTES }),
  rules: z.array(ClassificationRuleSchema).default([]),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type LedgerConfig = z.infer<typeof LedgerConfigSchema>;
export type ClassificationRule = z.infer<typeof ClassificationRuleSchema>;
export type SagazConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function parseConfig(raw: unknown, source = "sagaz.config.json"): SagazConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid ${source}:\n${issues}`);
  }
  if (Object.keys(result.data.servers).length === 0) {
    throw new ConfigError(`Invalid ${source}: "servers" must declare at least one downstream MCP server`);
  }
  return result.data;
}

/** Loads and validates a config file, resolving each server's `cwd` against the file's directory. */
export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<SagazConfig> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config at ${abs} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const config = parseConfig(raw, abs);
  const base = dirname(abs);
  for (const server of Object.values(config.servers)) {
    if (server.cwd !== undefined) server.cwd = resolve(base, server.cwd);
  }
  config.ledger.path = resolve(base, config.ledger.path);
  return config;
}
