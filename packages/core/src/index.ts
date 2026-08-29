/**
 * @sagaz/core — MCP proxy + effect ledger.
 *
 * Phase 0 / T3: transparent pass-through proxy. Ledger arrives in T4.
 */

export const CORE_VERSION = "0.0.0";

export {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  PREFIX_SEPARATOR,
  loadConfig,
  parseConfig,
  type SagazConfig,
  type ServerConfig,
} from "./config.js";
export { PROXY_NAME, SagazProxy, ToolCollisionError, buildRoutes, exposedName, type ProxyOptions } from "./proxy.js";
