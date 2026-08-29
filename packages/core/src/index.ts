/**
 * @sagaz/core — MCP proxy + effect ledger.
 *
 * Phase 0: transparent pass-through proxy + effect ledger v1.
 */

export const CORE_VERSION = "0.0.0";

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
