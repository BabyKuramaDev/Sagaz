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

/**
 * Build a config the way loadConfig would (defaults applied), with the guardian gate switched off:
 * these tests exercise routing and classification, and the toybox reel moves money. Gates have
 * their own describe below.
 */
const NO_GATES = { class: { I: "allow" } };
const cfgOf = (servers: Record<string, ServerConfig>): SagazConfig => parseConfig({ servers, policy: NO_GATES });

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

  it("records and classifies every call: session per initialize, R/C/I via the cascade, chained hashes", async () => {
    const db = join(dir, "world.db");
    toyboxCli(db, "seed");
    const ledger = new Ledger(join(dir, "ledger.db"));
    const config = parseConfig({ servers: { toybox: toybox(db) }, rules: [{ tool: "list_inbox", class: "unknown", reason: "user says so" }], policy: NO_GATES });
    const proxy = new SagazProxy(config, { log: () => {}, ledger });
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
      await client.callTool({ name: "list_timeline", arguments: {} }); // read without readOnlyHint
      await client.callTool({ name: "delete_contact", arguments: { id: 4 } }); // destructiveHint, delete_* → unknown
      await client.callTool({ name: "list_inbox", arguments: {} }); // readOnlyHint, but a user rule overrides

      const rows = ledger.listEffects(sessionId as string);
      expect(rows.map((r) => [r.seq, r.tool, r.class, r.class_source, r.status])).toEqual([
        [1, "list_contacts", "read", "annotation", "ok"],
        [2, "create_contact", "R", "rule", "ok"],
        [3, "transfer_funds", "I", "rule", "error"],
        [4, "list_timeline", "read", "rule", "ok"],
        [5, "delete_contact", "unknown", "rule", "ok"],
        [6, "list_inbox", "unknown", "user", "ok"],
      ]);
      expect(rows[5]?.class_reason).toBe("user says so");
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
        "create_contact", "delete_contact", "delete_tweet", "get_contact", "list_accounts", "list_contacts",
        "list_inbox", "list_timeline", "post_tweet", "send_email", "transfer_funds", "update_contact",
      ]);
    } finally {
      await client.close();
    }
  });

  it("`sagaz serve --preview` runs the session dry and says so in the instructions", async () => {
    const cfg = join(dir, "sagaz.config.json");
    const db = join(dir, "world.db");
    toyboxCli(db, "seed");
    writeFileSync(cfg, JSON.stringify({ servers: { toybox: toybox(db) }, ledger: { path: "ledger.db" } }));
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SAGAZ_BIN, "serve", "--preview", "--config", cfg], stderr: "pipe" }));
    try {
      expect(client.getInstructions()).toContain("Sagaz preview mode is active");
      const moved = (await client.callTool({ name: "transfer_funds", arguments: { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 1 } })) as CallToolResult;
      expect(text(moved)).toContain("recorded but NOT executed");
      expect(toyboxCli(db, "inspect")).toContain("TRANSFERS (0)");
    } finally {
      await client.close();
    }
    const ledger = new Ledger(join(dir, "ledger.db"), { readonly: true });
    expect(ledger.listEffects(ledger.lastSession()!.id).map((r) => [r.tool, r.status])).toEqual([["transfer_funds", "dry"]]);
    ledger.close();
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

describe("gates over a real toybox", () => {
  const balance = (dump: string, acc: string) => (dump.match(new RegExp(`${acc}\\s+\\S.*?\\s+(\\$[\\d,]+\\.\\d\\d)`)) ?? [])[1];
  const transfer = { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 250_000 };
  const gateMeta = (r: CallToolResult) => (r._meta as { sagaz: Record<string, unknown> }).sagaz;

  async function setup(policy: unknown, approvalPollMs = 10) {
    const db = join(dir, "world.db");
    toyboxCli(db, "seed");
    const ledgerPath = join(dir, "ledger.db");
    const ledger = new Ledger(ledgerPath);
    const proxy = new SagazProxy(parseConfig({ servers: { toybox: toybox(db) }, policy }), { log: () => {}, ledger, approvalPollMs });
    await proxy.start();
    const client = await connectClient(proxy);
    const operator = new Ledger(ledgerPath); // stands in for the `sagaz approve` process
    const close = async () => {
      await client.close();
      await proxy.close();
      operator.close();
      ledger.close();
    };
    return { db, ledger, proxy, client, operator, close };
  }

  it("guardian default: transfer_funds (I) is held; `approve` lets it through and the agent never notices", async () => {
    const t = await setup(undefined);
    try {
      const call = t.client.callTool({ name: "transfer_funds", arguments: transfer }) as Promise<CallToolResult>;
      // The call is parked: the effect is pending and `sagaz pending` would list it.
      let pending = t.operator.listPendingApprovals();
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        pending = t.operator.listPendingApprovals();
      }
      expect(pending).toMatchObject([{ tool: "transfer_funds", server: "toybox", class: "I" }]);
      expect(balance(toyboxCli(t.db, "inspect"), "acc-vendor")).toBe("$0.00");

      t.operator.decide(pending[0]!.id, "allow", "jero");
      const result = await call;
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text(result)).amount_cents).toBe(250_000);
      expect(balance(toyboxCli(t.db, "inspect"), "acc-vendor")).toBe("$2,500.00");

      const rows = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(rows.map((r) => [r.tool, r.class, r.status])).toEqual([["transfer_funds", "I", "ok"]]);
      expect(t.operator.listPendingApprovals()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("`deny` answers the denied template, records 'blocked' in the chain and the world is untouched", async () => {
    const t = await setup(undefined);
    try {
      const call = t.client.callTool({ name: "transfer_funds", arguments: transfer }) as Promise<CallToolResult>;
      let pending = t.operator.listPendingApprovals();
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        pending = t.operator.listPendingApprovals();
      }
      t.operator.decide(pending[0]!.id, "deny", "jero");
      const result = await call;
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("the operator (jero) denied it");
      expect(text(result)).toContain('`transfer_funds` on server "toybox" was NOT executed');
      expect(gateMeta(result)).toMatchObject({ gate: "denied", class: "I", decidedBy: "jero", policy: "default policy: class I → confirm" });
      expect(balance(toyboxCli(t.db, "inspect"), "acc-vendor")).toBe("$0.00");
      expect(toyboxCli(t.db, "inspect")).toContain("TRANSFERS (0)");

      // A read afterwards still flows, and the blocked row is part of the verified chain.
      await t.client.callTool({ name: "list_accounts", arguments: {} });
      const sid = t.proxy.currentSessionId as string;
      const rows = t.ledger.listEffects(sid);
      expect(rows.map((r) => [r.tool, r.status])).toEqual([["transfer_funds", "blocked"], ["list_accounts", "ok"]]);
      expect(JSON.parse(rows[0]!.result_json ?? "")).toMatchObject({ isError: true, _meta: { sagaz: { gate: "denied" } } });
      expect(t.ledger.verifySession(sid)).toMatchObject({ ok: true });
      expect(t.ledger.verifySession(sid).chain).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it("timeout → denied: the agent gets the timeout template and nothing moved", async () => {
    const t = await setup({ confirmTimeoutMs: 60 });
    try {
      const result = (await t.client.callTool({ name: "transfer_funds", arguments: transfer })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/no decision arrived within \d+ms, so it is treated as denied/);
      expect(gateMeta(result)).toMatchObject({ gate: "timeout", decidedBy: "timeout" });
      expect(balance(toyboxCli(t.db, "inspect"), "acc-vendor")).toBe("$0.00");
      expect(t.operator.listPendingApprovals()).toEqual([]);
      const sid = t.proxy.currentSessionId as string;
      expect(t.ledger.listEffects(sid).map((r) => r.status)).toEqual(["blocked"]);
      expect(t.ledger.verifySession(sid)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("agent cancels while held → closed as blocked/cancelled, and a later approve is refused (nothing runs)", async () => {
    const t = await setup(undefined);
    try {
      const controller = new AbortController();
      const call = t.client.callTool({ name: "transfer_funds", arguments: transfer }, undefined, { signal: controller.signal });
      let pending = t.operator.listPendingApprovals();
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        pending = t.operator.listPendingApprovals();
      }
      expect(pending).toHaveLength(1);
      controller.abort();
      await expect(call).rejects.toThrow();

      const sid = t.proxy.currentSessionId as string;
      let rows = t.ledger.listEffects(sid);
      for (let i = 0; i < 100 && rows[0]?.status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 10));
        rows = t.ledger.listEffects(sid);
      }
      expect(rows.map((r) => r.status)).toEqual(["blocked"]);
      expect(JSON.parse(rows[0]!.result_json ?? "")).toMatchObject({ _meta: { sagaz: { gate: "cancelled", decidedBy: "cancelled" } } });
      expect(t.operator.listPendingApprovals()).toEqual([]);
      expect(() => t.operator.decide(pending[0]!.id, "allow", "jero")).toThrow(/Already decided: deny by cancelled/);
      expect(balance(toyboxCli(t.db, "inspect"), "acc-vendor")).toBe("$0.00");
      expect(t.ledger.verifySession(sid)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("block: never reaches the downstream, no approval is opened, a tool rule beats the class map", async () => {
    const t = await setup({ class: { I: "allow", C: "allow" }, tools: [{ tool: "transfer_*", server: "toybox", action: "block", reason: "no money moves from a bot" }, { tool: "send_email", action: "confirm" }] });
    try {
      const result = (await t.client.callTool({ name: "transfer_funds", arguments: transfer })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Sagaz blocked this call before it reached the server");
      expect(text(result)).toContain("classified I (irreversible); no money moves from a bot");
      expect(balance(toyboxCli(t.db, "inspect"), "acc-vendor")).toBe("$0.00");
      expect(t.operator.listPendingApprovals()).toEqual([]);

      // send_email is C (allowed by class) but the tool rule says confirm → it is held.
      const call = t.client.callTool({ name: "send_email", arguments: { to: "ada@analytical.engine", subject: "s", body: "b" } }) as Promise<CallToolResult>;
      let pending = t.operator.listPendingApprovals();
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        pending = t.operator.listPendingApprovals();
      }
      expect(pending.map((p) => p.tool)).toEqual(["send_email"]);
      t.operator.decide(pending[0]!.id, "allow", "jero");
      expect((await call).isError).toBeFalsy();

      const rows = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(rows.map((r) => [r.tool, r.status])).toEqual([["transfer_funds", "blocked"], ["send_email", "ok"]]);
    } finally {
      await t.close();
    }
  });

  it("confirm without a ledger cannot degrade into allow: it blocks", async () => {
    const db = join(dir, "world.db");
    toyboxCli(db, "seed");
    const proxy = new SagazProxy(parseConfig({ servers: { toybox: toybox(db) } }), { log: () => {} });
    await proxy.start();
    const client = await connectClient(proxy);
    try {
      const result = (await client.callTool({ name: "transfer_funds", arguments: transfer })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Sagaz blocked this call");
      expect(balance(toyboxCli(db, "inspect"), "acc-vendor")).toBe("$0.00");
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});

describe("preview over a real toybox (sagaz serve --preview)", () => {
  const transfer = { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 250_000 };
  const meta = (r: CallToolResult) => (r._meta as { sagaz: Record<string, unknown> }).sagaz;

  async function setup(extra: Record<string, unknown> = {}, opts: { preview?: boolean } = { preview: true }) {
    const db = join(dir, "world.db");
    toyboxCli(db, "seed");
    const ledger = new Ledger(join(dir, "ledger.db"));
    const proxy = new SagazProxy(parseConfig({ servers: { toybox: toybox(db) }, ...extra }), { log: () => {}, ledger, approvalPollMs: 10, ...opts });
    await proxy.start();
    const client = await connectClient(proxy);
    const close = async () => {
      await client.close();
      await proxy.close();
      ledger.close();
    };
    return { db, ledger, proxy, client, close };
  }

  it("reads are forwarded, every mutation and unknown runs dry, I never waits, the chain holds and the world is virgin", async () => {
    const t = await setup();
    const before = toyboxCli(t.db, "inspect");
    try {
      expect(t.proxy.isPreview).toBe(true);
      expect(t.client.getInstructions()).toContain("Sagaz preview mode is active");

      // Reads reach the world — an annotated one and one the heuristics have to infer.
      const contacts = (await t.client.callTool({ name: "list_contacts", arguments: {} })) as CallToolResult;
      expect(JSON.parse(text(contacts))).toHaveLength(3);
      expect(contacts._meta).toBeUndefined();
      const timeline = (await t.client.callTool({ name: "list_timeline", arguments: {} })) as CallToolResult;
      expect(JSON.parse(text(timeline))[0].text).toBe("Hello world, we are live!");

      // R and C: spoken, not executed, not an error (the agent keeps planning).
      const created = (await t.client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } })) as CallToolResult;
      expect(created.isError).toBeFalsy();
      expect(text(created)).toContain("Preview mode: this call was recorded but NOT executed. `create_contact` on server \"toybox\" did not run and nothing changed.");
      expect(text(created)).toContain("It would have been classified R (reversible); outside preview it would have run.");
      expect(text(created)).toContain("nothing you do in this session reaches the real world");
      expect(meta(created)).toEqual({ preview: true, class: "R", wouldHave: "allow", policy: "default policy: class R → allow" });
      const sent = (await t.client.callTool({ name: "send_email", arguments: { to: "alan@bletchley.uk", subject: "Welcome", body: "Hi" } })) as CallToolResult;
      expect(meta(sent)).toMatchObject({ preview: true, class: "C", wouldHave: "allow" });

      // I: dry, not pending — no approval is opened, nobody waits, the guardian is reported, not applied.
      const moved = (await t.client.callTool({ name: "transfer_funds", arguments: transfer })) as CallToolResult;
      expect(text(moved)).toContain("It would have been classified I (irreversible); outside preview it would have waited for the operator's approval.");
      expect(meta(moved)).toMatchObject({ preview: true, class: "I", wouldHave: "confirm", policy: "default policy: class I → confirm" });
      expect(t.ledger.listPendingApprovals()).toEqual([]);

      // unknown: when in doubt, dry.
      const deleted = (await t.client.callTool({ name: "delete_contact", arguments: { id: 1 } })) as CallToolResult;
      expect(text(deleted)).toContain("It would have been classified unknown reversibility");
      expect(meta(deleted)).toMatchObject({ preview: true, class: "unknown" });

      const sid = t.proxy.currentSessionId as string;
      const rows = t.ledger.listEffects(sid);
      expect(rows.map((r) => [r.tool, r.class, r.status])).toEqual([
        ["list_contacts", "read", "ok"], ["list_timeline", "read", "ok"], ["create_contact", "R", "dry"],
        ["send_email", "C", "dry"], ["transfer_funds", "I", "dry"], ["delete_contact", "unknown", "dry"],
      ]);
      expect(rows.filter((r) => r.status === "pending")).toEqual([]);
      // Dry rows are chained like any other: what the agent was told is what the ledger stores.
      expect(JSON.parse(rows[4]!.result_json ?? "")).toMatchObject({ isError: false, _meta: { sagaz: { preview: true, class: "I", wouldHave: "confirm" } } });
      const verified = t.ledger.verifySession(sid);
      expect(verified).toMatchObject({ ok: true });
      expect(verified.chain).toHaveLength(6);

      // The world, checked against the toybox's own DB: byte-for-byte what `seed` left.
      const after = toyboxCli(t.db, "inspect");
      expect(after).toBe(before);
      expect(after).toContain("CONTACTS (3)");
      expect(after).not.toContain("Alan Turing");
      expect(after).toContain("EMAILS SENT (1)");
      expect(after).toContain("TRANSFERS (0)");
      expect(after).toMatch(/acc-vendor\s+Vendor Escrow\s+\$0\.00/);
    } finally {
      await t.close();
    }
  });

  it("the policy does not run in preview: a block rule and a confirm class both end dry, and are reported as what they would have done", async () => {
    const t = await setup({ policy: { class: { unknown: "confirm" }, tools: [{ tool: "send_*", action: "block", reason: "no outbound mail" }] } });
    try {
      const sent = (await t.client.callTool({ name: "send_email", arguments: { to: "x@y.z", subject: "s", body: "b" } })) as CallToolResult;
      expect(sent.isError).toBeFalsy();
      expect(text(sent)).toContain("outside preview the policy would have blocked it");
      expect(meta(sent)).toMatchObject({ preview: true, wouldHave: "block", policy: "no outbound mail" });
      const deleted = (await t.client.callTool({ name: "delete_contact", arguments: { id: 1 } })) as CallToolResult;
      expect(meta(deleted)).toMatchObject({ preview: true, class: "unknown", wouldHave: "confirm" });
      expect(t.ledger.listPendingApprovals()).toEqual([]);
      expect(t.ledger.listEffects(t.proxy.currentSessionId as string).map((r) => r.status)).toEqual(["dry", "dry"]);
      expect(toyboxCli(t.db, "inspect")).toContain("CONTACTS (3)");
    } finally {
      await t.close();
    }
  });

  it("`\"preview\": true` in the config is the same switch; a user rule that says read is trusted (documented edge)", async () => {
    const t = await setup({ preview: true, rules: [{ tool: "post_tweet", class: "read", reason: "lying on purpose" }] }, {});
    try {
      expect(t.proxy.isPreview).toBe(true);
      const moved = (await t.client.callTool({ name: "transfer_funds", arguments: transfer })) as CallToolResult;
      expect(meta(moved)).toMatchObject({ preview: true, class: "I" });
      // The cascade decides what a read is; a rule that misclassifies a mutation as read lets it through.
      const tweeted = (await t.client.callTool({ name: "post_tweet", arguments: { text: "oops" } })) as CallToolResult;
      expect(tweeted._meta).toBeUndefined();
      expect(toyboxCli(t.db, "inspect")).toContain("oops");
      expect(toyboxCli(t.db, "inspect")).toContain("TRANSFERS (0)");
      // The annotation path of the same edge: delete_contact carries destructiveHint (not readOnlyHint),
      // so the annotation level does not make it a read and it stays dry; list_inbox's readOnlyHint does.
      const deleted = (await t.client.callTool({ name: "delete_contact", arguments: { id: 1 } })) as CallToolResult;
      expect(meta(deleted)).toMatchObject({ preview: true, class: "unknown" });
      const inbox = (await t.client.callTool({ name: "list_inbox", arguments: {} })) as CallToolResult;
      expect(inbox._meta).toBeUndefined();
      expect(t.ledger.listEffects(t.proxy.currentSessionId as string).map((r) => [r.tool, r.class_source, r.status])).toEqual([
        ["transfer_funds", "rule", "dry"], ["post_tweet", "user", "ok"], ["delete_contact", "rule", "dry"], ["list_inbox", "annotation", "ok"],
      ]);
    } finally {
      await t.close();
    }
  });

  it("without preview nothing changes: the same call runs for real", async () => {
    const t = await setup({ policy: NO_GATES }, {});
    try {
      expect(t.proxy.isPreview).toBe(false);
      const c = (await t.client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } })) as CallToolResult;
      expect(c._meta).toBeUndefined();
      expect(toyboxCli(t.db, "inspect")).toContain("Alan Turing");
    } finally {
      await t.close();
    }
  });
});
