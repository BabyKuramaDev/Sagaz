import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // One published package: sagaz-core is a private workspace package, bundled here. Everything
  // else (the MCP SDK, zod, and the native better-sqlite3) stays external and is declared below.
  noExternal: ["sagaz-core"],
  target: "node20",
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
