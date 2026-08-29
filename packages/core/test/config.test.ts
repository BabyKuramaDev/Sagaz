import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("accepts the mcpServers-like shape plus optional prefix", () => {
    const c = parseConfig({ servers: { toybox: { command: "node", args: ["x.js"], env: { A: "1" }, prefix: "tb" } } });
    expect(c.servers["toybox"]?.prefix).toBe("tb");
  });
  it("rejects empty servers, bad prefixes and unknown shapes with a readable message", () => {
    expect(() => parseConfig({ servers: {} })).toThrow(/at least one downstream/);
    expect(() => parseConfig({ servers: { t: { command: "node", prefix: "bad prefix" } } })).toThrow(/prefix must match/);
    expect(() => parseConfig({ nope: true })).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sagaz-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves cwd relative to the config file", async () => {
    const p = join(dir, "sagaz.config.json");
    writeFileSync(p, JSON.stringify({ servers: { a: { command: "node", cwd: "sub" } } }));
    const c = await loadConfig(p);
    expect(c.servers["a"]?.cwd).toBe(join(dir, "sub"));
  });
  it("reports missing files and invalid JSON as ConfigError", async () => {
    await expect(loadConfig(join(dir, "missing.json"))).rejects.toThrow(/Cannot read config/);
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    await expect(loadConfig(p)).rejects.toThrow(/not valid JSON/);
  });
});
