import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SagazProxy, ToolCollisionError, buildRoutes } from "../src/proxy.js";
import { parseConfig, type SagazConfig, type ServerConfig } from "../src/config.js";
import { Ledger } from "../src/ledger/index.js";

/** Build a config the way loadConfig would (defaults applied). */
const cfgOf = (servers: Record<string, ServerConfig>): SagazConfig => parseConfig({ servers });

const TOYBOX_BIN = fileURLToPath(new URL("../../toybox/dist/index.js", import.meta.url));
if (!existsSync(TOYBOX_BIN)) throw new Error(`toybox not built (${TOYBOX_BIN}). Run \`pnpm build\` before \`pnpm test\`.`);

/** Operate the world out-of-band, like a human would: `sagaz-toybox seed` / `inspect`. */
function toyboxCli(db: string, cmd: "seed" | "inspect"): string {
  return execFileSync(process.execPath, [TOYBOX_BIN, cmd], { encoding: "utf8", env: { ...process.env, TOYBOX_DB: db } });
}

function toybox(db: string, prefix?: string) {
  return { command: process.execPath, args: [TOYBOX_BIN], env: { TOYBOX_DB: db }, ...(prefix ? { prefix } : {}) };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sagaz-proxy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function connectClient(proxy: SagazProxy): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await proxy.serve(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const text = (r: CallToolResult) => (r.content[0]?.type === "text" ? r.content[0].text : "");

describe("buildRoutes", () => {
  const cfg = cfgOf({ a: { command: "x" }, b: { command: "y" } });
  const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

  it("passes names through unchanged, regardless of server count", () => {
    const routes = buildRoutes(cfg, new Map([["a", [tool("send_email")]], ["b", [tool("list_rows")]]]));
    expect([...routes.keys()]).toEqual(["send_email", "list_rows"]);
  });
  it("fails on collision with a message that suggests the prefix fix", () => {
    expect(() => buildRoutes(cfg, new Map([["a", [tool("send_email")]], ["b", [tool("send_email")]]]))).toThrow(ToolCollisionError);
    expect(() => buildRoutes(cfg, new Map([["a", [tool("send_email")]], ["b", [tool("send_email")]]]))).toThrow(
      /"send_email" is exposed by both "a" and "b"[\s\S]*"prefix": "b"[\s\S]*b__send_email/,
    );
  });
  it("applies an explicit prefix only to the server that declares it", () => {
    const withPrefix = cfgOf({ a: { command: "x" }, b: { command: "y", prefix: "bee" } });
    const routes = buildRoutes(withPrefix, new Map([["a", [tool("send_email")]], ["b", [tool("send_email")]]]));
    expect([...routes.keys()]).toEqual(["send_email", "bee__send_email"]);
  });
});

describe("SagazProxy over a real toybox (stdio downstream)", () => {
  it("runs the reel through Sagaz: seed → create_contact → send_email → transfer_funds", async () => {
    const db = join(dir, "world.db");
    const proxy = new SagazProxy(cfgOf({ toybox: toybox(db) }), { log: () => {} });
    await proxy.start();
    const client = await connectClient(proxy);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("transfer_funds");
      expect(names).toContain("list_contacts");
      expect(names.some((n) => n.includes("__"))).toBe(false);

      // Seed the world out-of-band — the reel then runs through the proxy.
      toyboxCli(db, "seed");

      const c = (await client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } })) as CallToolResult;
      expect(JSON.parse(text(c)).id).toBe(4);
      const e = (await client.callTool({ name: "send_email", arguments: { to: "alan@bletchley.uk", subject: "Welcome", body: "Hi" } })) as CallToolResult;
      expect(JSON.parse(text(e)).id).toBe(2);
      const t = (await client.callTool({ name: "transfer_funds", arguments: { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 250_000 } })) as CallToolResult;
      expect(JSON.parse(text(t)).amount_cents).toBe(250_000);

      const bad = (await client.callTool({ name: "transfer_funds", arguments: { from_account: "acc-vendor", to_account: "acc-ops", amount_cents: 999_999_999 } })) as CallToolResult;
      expect(bad.isError).toBe(true);

      const dump = toyboxCli(db, "inspect");
      expect(dump).toContain("Alan Turing <alan@bletchley.uk>");
      expect(dump).toContain('to alan@bletchley.uk  "Welcome"');
      expect(dump).toContain("acc-payroll -> acc-vendor  $2,500.00");
    } finally {
      await client.close();
      await proxy.close();
    }
  });

  it("records every call in the ledger: session per initialize, read via readOnlyHint, chained hashes", async () => {
    const db = join(dir, "world.db");
    toyboxCli(db, "seed");
    const ledger = new Ledger(join(dir, "ledger.db"));
    const proxy = new SagazProxy(cfgOf({ toybox: toybox(db) }), { log: () => {}, ledger });
    await proxy.start();
    expect(proxy.currentSessionId).toBeUndefined();
    const client = await connectClient(proxy);
    try {
      const sessionId = proxy.currentSessionId;
      expect(sessionId).toBeDefined();
      const session = ledger.getSession(sessionId as string);
      expect(JSON.parse(session?.client_info ?? "null")).toMatchObject({ name: "test-client" });

      await client.callTool({ name: "list_contacts", arguments: {} });
      await client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } });
      await client.callTool({ name: "transfer_funds", arguments: { from_account: "acc-vendor", to_account: "acc-ops", amount_cents: 999_999_999 } });

      const rows = ledger.listEffects(sessionId as string);
      expect(rows.map((r) => [r.seq, r.tool, r.class, r.class_source, r.status])).toEqual([
        [1, "list_contacts", "read", "annotation", "ok"],
        [2, "create_contact", null, null, "ok"],
        [3, "transfer_funds", null, null, "error"],
      ]);
      expect(JSON.parse(rows[1]?.args_json ?? "")).toEqual({ name: "Alan Turing", email: "alan@bletchley.uk" });
      expect(rows[0]?.prev_hash).toBe(session?.genesis_hash);
      expect(rows[1]?.prev_hash).toBe(rows[0]?.hash);
      expect(rows[2]?.prev_hash).toBe(rows[1]?.hash);
      expect(ledger.verifySession(sessionId as string).ok).toBe(true);

      // A second client initialize (after the first disconnects) → a second session.
      await client.close();
      const client2 = await connectClient(proxy);
      expect(proxy.currentSessionId).not.toBe(sessionId);
      expect(ledger.listSessions()).toHaveLength(2);
      await client2.close();
    } finally {
      await proxy.close();
      ledger.close();
    }
  });

  it("refuses to start when two downstream servers collide, and works with a prefix", async () => {
    const collide = new SagazProxy(cfgOf({ one: toybox(join(dir, "a.db")), two: toybox(join(dir, "b.db")) }), { log: () => {} });
    await expect(collide.start()).rejects.toThrow(/collision[\s\S]*"prefix": "two"/);
    await collide.close();

    const prefixed = new SagazProxy(cfgOf({ one: toybox(join(dir, "a.db")), two: toybox(join(dir, "b.db"), "two") }), { log: () => {} });
    try {
      await prefixed.start();
      expect(prefixed.toolNames).toContain("send_email");
      expect(prefixed.toolNames).toContain("two__send_email");
      const client = await connectClient(prefixed);
      const r = (await client.callTool({ name: "two__list_accounts", arguments: {} })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      await client.close();
    } finally {
      await prefixed.close();
    }
  });
});

describe("sagaz bin end to end (stdio both sides)", () => {
  const SAGAZ_BIN = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  if (!existsSync(SAGAZ_BIN)) throw new Error(`sagaz cli not built (${SAGAZ_BIN}). Run \`pnpm build\` before \`pnpm test\`.`);

  it("serves the toybox through `sagaz serve --config`", async () => {
    const cfg = join(dir, "sagaz.config.json");
    writeFileSync(cfg, JSON.stringify({ servers: { toybox: toybox(join(dir, "world.db")) } }));
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SAGAZ_BIN, "serve", "--config", cfg], stderr: "pipe" }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "create_contact", "delete_contact", "delete_tweet", "list_accounts", "list_contacts", "list_inbox",
        "list_timeline", "post_tweet", "send_email", "transfer_funds", "update_contact",
      ]);
    } finally {
      await client.close();
    }
  });

  it("exits 1 with the collision message (and does not hang) when downstreams collide", async () => {
    const cfg = join(dir, "collide.json");
    writeFileSync(cfg, JSON.stringify({ servers: { one: toybox(join(dir, "a.db")), two: toybox(join(dir, "b.db")) } }));
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [SAGAZ_BIN, "serve", "--config", cfg], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`sagaz serve did not exit after collision; stderr:\n${stderr}`));
      }, 10_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/Tool name collision[\s\S]*"prefix": "two"/);
  });
});
