import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** CLI package version, read from package.json at runtime (single source of truth). */
export const CLI_VERSION: string = pkg.version;
