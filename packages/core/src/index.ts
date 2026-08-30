/**
 * sagaz-core — MCP proxy + effect ledger.
 *
 * Transparent pass-through proxy + R/C/I classifier (levels 1–3) + policy gates + effect ledger v1.
 */

import { createRequire } from "node:module";

/** Package version, read from package.json at runtime (single source of truth, same as the CLI). */
export const CORE_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export {
  ConfigError,
  DEFAULT_CLASS_POLICY,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  PREFIX_SEPARATOR,
  loadConfig,
  parseConfig,
  type ClassificationRule,
  type LedgerConfig,
  type ParseConfigOptions,
  type PolicyAction,
  type PolicyConfig,
  type PolicyToolRule,
  type SagazConfig,
  type ServerConfig,
} from "./config.js";
export * from "./classifier/index.js";
export * from "./ledger/index.js";
export * from "./policy/index.js";
export * from "./undo/index.js";
export {
  DEFAULT_CAPTURE_TIMEOUT_MS,
  PROXY_NAME,
  PackCollisionError,
  SagazProxy,
  ToolCollisionError,
  assertNoPackCollisions,
  buildRoutes,
  exposedName,
  probeDownstreamTools,
  type ProxyOptions,
} from "./proxy.js";
