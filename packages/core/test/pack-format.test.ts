/**
 * T11 — the compensation pack format is a PUBLIC contract people write by hand, so these tests
 * are mostly about rejection quality: every invalid pack must fail with an error that names the
 * exact field and what was expected. Plus: the config loader (`"packs"`: inline objects and
 * paths relative to the config), duplicate names, glob matching and cross-pack collisions.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { PackError, loadPackFile, parsePack } from "../src/undo/pack-format.js";
import { matchPack, type CompensationPack } from "../src/undo/packs.js";
import { PackCollisionError, assertNoPackCollisions } from "../src/proxy.js";

const VALID = {
  name: "crm",
  description: "CRM inverses",
  entries: [
    {
      tool: "delete_*",
      server: "crm",
      note: "restores the captured row",
      capture: { tool: "get_row", args: { id: "$.args.id" } },
      inverse: { tool: "create_row", args: { id: "$.pre_state.id", name: "$.pre_state.name" } },
    },
    { tool: "create_row", inverse: { tool: "delete_row", args: { id: "$.result.id" } } },
  ],
};

describe("parsePack — what a valid pack looks like", () => {
  it("accepts the full shape: glob tool, optional server/note/capture, mapped args", () => {
    const pack = parsePack(VALID, "test");
    expect(pack.name).toBe("crm");
    expect(pack.entries[0]?.capture?.tool).toBe("get_row");
    expect(pack.entries[1]?.note).toBeUndefined();
  });
});

describe("parsePack — rejection quality (people write these by hand)", () => {
  const bad = (mutate: (p: Record<string, unknown>) => void): (() => void) => {
    const clone = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
    mutate(clone);
    return () => parsePack(clone, "handwritten.json");
  };

  it("names the source in every error", () => {
    expect(bad((p) => delete p["name"])).toThrow(/handwritten\.json/);
  });
  it("missing name / empty description / empty entries — each error points at the field", () => {
    expect(bad((p) => delete p["name"])).toThrow(/- name:/);
    expect(bad((p) => (p["description"] = ""))).toThrow(/- description: .*what the pack covers/);
    expect(bad((p) => (p["entries"] = []))).toThrow(/- entries: .*at least one entry/);
  });
  it("an unknown key is a typo, not an extension — strict at every level", () => {
    expect(bad((p) => (p["extra"] = 1))).toThrow(PackError);
    expect(bad((p) => (((p["entries"] as unknown[])[0] as Record<string, unknown>)["inverze"] = {}))).toThrow(/entries\.0.*"inverze"/s);
  });
  it("a capture arg can only read $.args — the error says what exists at that point", () => {
    expect(
      bad((p) => ((((p["entries"] as unknown[])[0] as Record<string, Record<string, Record<string, string>>>)["capture"]!["args"]!["id"] = "$.result.id"))),
    ).toThrow(/entries\.0\.capture\.args\.id: .*\$\.result.*does not exist here.*\$\.args/s);
  });
  it("a malformed reference is rejected with the expected shapes spelled out", () => {
    expect(
      bad((p) => ((((p["entries"] as unknown[])[1] as Record<string, Record<string, Record<string, string>>>)["inverse"]!["args"]!["id"] = "result.id"))),
    ).toThrow(/entries\.1\.inverse\.args\.id: "result\.id" is not a reference — expected \$\.args\.x or \$\.result\.x or \$\.pre_state\.x/);
  });
  it("a bare root is not a reference either — the contract only describes fields", () => {
    expect(
      bad((p) => ((((p["entries"] as unknown[])[1] as Record<string, Record<string, Record<string, string>>>)["inverse"]!["args"]!["id"] = "$.result"))),
    ).toThrow(/entries\.1\.inverse\.args\.id: "\$\.result" is not a reference/);
  });
  it("an inverse reading $.pre_state without a capture is caught at parse time, not at runtime", () => {
    expect(
      bad((p) => delete ((p["entries"] as unknown[])[0] as Record<string, unknown>)["capture"]),
    ).toThrow(/entries\.0\.inverse\.args\.id: references \$\.pre_state but the entry declares no "capture"/);
  });
});

describe("loadPackFile and the config loader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sagaz-pack-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("config packs: inline objects and file paths (relative to the config) both load", () => {
    const packPath = join(dir, "my-pack.json");
    writeFileSync(packPath, JSON.stringify(VALID));
    const inline = { ...VALID, name: "inline" };
    const config = parseConfig({ servers: { s: { command: "x" } }, packs: [inline, "my-pack.json"] }, "cfg", { baseDir: dir });
    expect(config.packs.map((p) => p.name)).toEqual(["inline", "crm"]);
  });
  it("a missing or unparsable pack file names the resolved path", () => {
    expect(() => parseConfig({ servers: { s: { command: "x" } }, packs: ["gone.json"] }, "cfg", { baseDir: dir })).toThrow(
      new RegExp(`Cannot read compensation pack at ${join(dir, "gone.json")}`),
    );
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => loadPackFile(join(dir, "bad.json"))).toThrow(/not valid JSON/);
  });
  it("an invalid pack file fails with the file path and the exact field", () => {
    writeFileSync(join(dir, "typo.json"), JSON.stringify({ ...VALID, entries: [{ tool: "t", inverse: { tool: "u", args: { id: "$.nope.id" } } }] }));
    expect(() => loadPackFile(join(dir, "typo.json"))).toThrow(/typo\.json.*entries\.0\.inverse\.args\.id/s);
  });
  it("a path in an inline-parsed config (no file, nothing to resolve against) is refused with the fix", () => {
    expect(() => parseConfig({ servers: { s: { command: "x" } }, packs: ["p.json"] })).toThrow(/not loaded from a file.*inline the pack/s);
  });
  it("two packs with the same name are a conflict, never merged", () => {
    expect(() => parseConfig({ servers: { s: { command: "x" } }, packs: [VALID, VALID] }, "cfg")).toThrow(/two packs are named "crm".*rename one/s);
  });
});

describe("matchPack (globs, server scope) and cross-pack collisions", () => {
  const pack = (name: string, tool: string, server?: string): CompensationPack => ({
    name,
    description: "d",
    entries: [{ tool, ...(server === undefined ? {} : { server }), inverse: { tool: "inv", args: {} } }],
  });

  it("matches exact names and globs; server scope respected; first pack wins only after collisions are excluded", () => {
    expect(matchPack([pack("a", "delete_*")], "delete_row", "s")?.pack.name).toBe("a");
    expect(matchPack([pack("a", "delete_*")], "undelete_row", "s")).toBeUndefined();
    expect(matchPack([pack("a", "t", "other")], "t", "s")).toBeUndefined();
  });

  it("two packs covering the same downstream tool refuse to start, naming both", () => {
    const tools = new Map<string, Tool[]>([["crm", [{ name: "delete_row", inputSchema: { type: "object" } } as Tool]]]);
    expect(() => assertNoPackCollisions([pack("a", "delete_*"), pack("b", "delete_row")], tools)).toThrow(PackCollisionError);
    expect(() => assertNoPackCollisions([pack("a", "delete_*"), pack("b", "delete_row")], tools)).toThrow(
      /"delete_row" on server "crm" is covered by pack "a" \(entry "delete_\*"\) and pack "b" \(entry "delete_row"\)/,
    );
    // Same two entries INSIDE one pack: author's order, first match wins, no error.
    const merged: CompensationPack = { name: "a", description: "d", entries: [...pack("a", "delete_*").entries, ...pack("a", "delete_row").entries] };
    expect(() => assertNoPackCollisions([merged], tools)).not.toThrow();
    expect(matchPack([merged], "delete_row", "crm")?.entry.tool).toBe("delete_*");
  });
});
