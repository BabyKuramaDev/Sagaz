/**
 * @sagaz/core — MCP proxy + effect ledger.
 *
 * Phase 0: transparent pass-through proxy + effect ledger v1.
 */

import { createRequire } from "node:module";

/** Package version, read from package.json at runtime (single source of truth, same as the CLI). */
export const CORE_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  PREFIX_SEPARATOR,
  loadConfig,
  parseConfig,
  type LedgerConfig,
  type SagazConfig,
  type ServerConfig,
} from "./config.js";
export * from "./ledger/index.js";
export { PROXY_NAME, SagazProxy, ToolCollisionError, buildRoutes, exposedName, type ProxyOptions } from "./proxy.js";
