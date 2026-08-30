/**
 * T10 — capture hook + undo plans. The four checkpoint cases plus the guardrails:
 * plan-from-result, capture → pre-state → plan, capture failure (error / tool error /
 * timeout) never touching the agent, capture-after-gates (a blocked call captures nothing),
 * pre_state_json inside the hash, the global `capture: false` switch, and preview staying inert.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SagazProxy } from "../src/proxy.js";
import { parseConfig } from "../src/config.js";
import { Ledger, type EffectRow } from "../src/ledger/index.js";
import { loadPackFile } from "../src/undo/pack-format.js";
import { PathError, mapArgs, matchPackEntry, payloadOf, resolveReference, type CompensationPack, type PackEntry } from "../src/undo/index.js";

const TOYBOX_BIN = fileURLToPath(new URL("../../toybox/dist/index.js", import.meta.url));
if (!existsSync(TOYBOX_BIN)) throw new Error(`toybox not built (${TOYBOX_BIN}). Run \`pnpm build\` before \`pnpm test\`.`);
/** The OFFICIAL toybox pack file — these e2e tests run against the real contract. */
const TOYBOX_PACK = loadPackFile(fileURLToPath(new URL("../../toybox/sagaz-pack.json", import.meta.url)));
/** Wraps loose entries as a pack, for tests that only care about the entries. */
const packOf = (entries: PackEntry[], name = "test-pack"): CompensationPack[] => [{ name, description: "test entries", entries }];

function toyboxCli(db: string, cmd: "seed" | "inspect"): string {
  return execFileSync(process.execPath, [TOYBOX_BIN, cmd], { encoding: "utf8", env: { ...process.env, TOYBOX_DB: db } });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sagaz-capture-"));
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
const undoOf = (r: EffectRow) => (r.undo_json === null ? null : (JSON.parse(r.undo_json) as Record<string, unknown>));
const preStateOf = (r: EffectRow) => {
  if (r.pre_state_json === null) return null;
  const captured = JSON.parse(r.pre_state_json) as CallToolResult;
  return JSON.parse(captured.content[0]?.type === "text" ? captured.content[0].text : "null") as unknown;
};

async function overToybox(extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const db = join(dir, "world.db");
  toyboxCli(db, "seed");
  const ledgerPath = join(dir, "ledger.db");
  const ledger = new Ledger(ledgerPath);
  const config = parseConfig({
    servers: { toybox: { command: process.execPath, args: [TOYBOX_BIN], env: { TOYBOX_DB: db } } },
    policy: { class: { I: "allow" } },
    packs: [TOYBOX_PACK],
    ...extra,
  });
  const proxy = new SagazProxy(config, { log: () => {}, ledger, ...opts });
  await proxy.start();
  const client = await connectClient(proxy);
  const close = async () => {
    await client.close();
    await proxy.close();
    ledger.close();
  };
  return { db, ledgerPath, ledger, proxy, client, close };
}

describe("capture hook + undo plans over a real toybox (official pack file)", () => {
  it("create_contact: inverse derived from the result alone — planned, no pre-state needed", async () => {
    const t = await overToybox();
    try {
      const r = (await t.client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r)).id).toBe(4);

      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ tool: "create_contact", status: "ok", undo_status: "planned", pre_state_json: null });
      expect(undoOf(row!)).toEqual({ kind: "tool_call", server: "toybox", tool: "delete_contact", args: { id: 4 } });
    } finally {
      await t.close();
    }
  });

  it("delete_contact: the whole contact is captured before it dies, and the inverse rebuilds it from the pre-state", async () => {
    const t = await overToybox();
    try {
      const r = (await t.client.callTool({ name: "delete_contact", arguments: { id: 2 } })) as CallToolResult;
      // The agent sees exactly what the toybox answers — the capture is invisible.
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r)).name).toBe("Grace Hopper");
      expect(toyboxCli(t.db, "inspect")).not.toContain("Grace Hopper");

      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ tool: "delete_contact", status: "ok", undo_status: "planned" });
      // T11: no more `unknown` — the pack declares the inverse, so the class is R with pack
      // provenance, and destructiveHint (delete_contact carries it) does NOT cap an R by pack.
      expect(row).toMatchObject({ class: "R", class_source: "pack", class_reason: expect.stringContaining('"toybox-crm"') });
      expect(preStateOf(row!)).toMatchObject({ id: 2, name: "Grace Hopper", email: "grace@cobol.navy", company: "US Navy" });
      // T11: the inverse restores IDENTITY too — id travels from the captured pre-state.
      expect(undoOf(row!)).toEqual({
        kind: "tool_call", server: "toybox", tool: "create_contact",
        args: { id: 2, name: "Grace Hopper", email: "grace@cobol.navy", company: "US Navy" },
      });
      // The pre-state is sealed inside the hash: the chain verifies with it in place…
      expect(t.ledger.verifySession(t.proxy.currentSessionId as string)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("a contact without company survives the round trip: the inverse carries company: null and create_contact accepts it", async () => {
    const t = await overToybox();
    try {
      await t.client.callTool({ name: "create_contact", arguments: { name: "Nameless Co", email: "no@company.io" } });
      await t.client.callTool({ name: "delete_contact", arguments: { id: 4 } });
      const rows = t.ledger.listEffects(t.proxy.currentSessionId as string);
      const plan = undoOf(rows[1]!) as { args: Record<string, unknown> };
      expect(plan.args).toEqual({ id: 4, name: "Nameless Co", email: "no@company.io", company: null });
      // The planned inverse actually runs (what T12 will execute) — and restores the original id.
      const undone = (await t.client.callTool({ name: "create_contact", arguments: plan.args })) as CallToolResult;
      expect(undone.isError).toBeFalsy();
      expect(JSON.parse(text(undone))).toMatchObject({ id: 4, company: null });
    } finally {
      await t.close();
    }
  });

  it("tampering with a stored pre-state breaks the chain: pre_state_json is inside the hash", async () => {
    const t = await overToybox();
    let sessionId: string;
    try {
      await t.client.callTool({ name: "delete_contact", arguments: { id: 1 } });
      sessionId = t.proxy.currentSessionId as string;
      expect(t.ledger.verifySession(sessionId)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
    const raw = new Database(t.ledgerPath);
    raw.prepare("UPDATE effects SET pre_state_json = '\"tampered\"'").run();
    raw.close();
    const reader = new Ledger(t.ledgerPath, { readonly: true });
    expect(reader.verifySession(sessionId)).toMatchObject({ ok: false, reason: expect.stringMatching(/hash mismatch|unreachable/) });
    reader.close();
  });

  it("capture failure (capture tool gone): the agent never notices, the ledger records the no-plan and why", async () => {
    // The capture read points at a tool that no longer exists — the "killed tool" of the checkpoint.
    const brokenPack: PackEntry[] = [{
      tool: "delete_contact",
      capture: { tool: "get_contact_gone", args: { id: "$.args.id" } },
      inverse: { tool: "create_contact", args: { name: "$.pre_state.name", email: "$.pre_state.email" } },
    }];
    const t = await overToybox({}, { packs: packOf(brokenPack) });
    try {
      const r = (await t.client.callTool({ name: "delete_contact", arguments: { id: 3 } })) as CallToolResult;
      // The effect ran exactly as if the capture did not exist.
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r)).name).toBe("Linus Torvalds");
      expect(toyboxCli(t.db, "inspect")).not.toContain("Linus Torvalds");

      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ status: "ok", undo_status: "none", pre_state_json: null });
      expect(undoOf(row!)).toMatchObject({ kind: "no_plan", reason: expect.stringContaining("get_contact_gone") });
      expect(t.ledger.verifySession(t.proxy.currentSessionId as string)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("`\"capture\": false` switches the whole mechanism off: no pre-state, no plans", async () => {
    const t = await overToybox({ capture: false });
    try {
      await t.client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } });
      await t.client.callTool({ name: "delete_contact", arguments: { id: 1 } });
      const rows = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(rows.map((r) => [r.status, r.undo_status, r.pre_state_json, r.undo_json])).toEqual([
        ["ok", "none", null, null],
        ["ok", "none", null, null],
      ]);
      // With capture off the packs are inert for CLASSIFICATION too: an inverse whose
      // pre-state will never be captured is not a known inverse, so no R by pack.
      expect(rows[1]).toMatchObject({ tool: "delete_contact", class: "unknown" });
    } finally {
      await t.close();
    }
  });
});

describe("capture hook against a controllable downstream (failure modes and gates)", () => {
  /** A fake downstream whose behaviour and call counts the test controls. */
  function fake() {
    const calls: Record<string, number> = {};
    const count = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);
    const connect = (): Transport => {
      const server = new McpServer({ name: "fake", version: "0.0.0" });
      server.registerTool("read_thing", { inputSchema: { id: z.number() } }, ({ id }) => {
        count("read_thing");
        return { content: [{ type: "text", text: JSON.stringify({ id, value: "before" }) }] };
      });
      server.registerTool("read_hangs", { inputSchema: { id: z.number() } }, () => {
        count("read_hangs");
        return new Promise(() => {}); // never resolves — the capture timeout must fire
      });
      server.registerTool("read_fails", { inputSchema: { id: z.number() } }, () => {
        count("read_fails");
        return { isError: true, content: [{ type: "text", text: "reader exploded" }] };
      });
      server.registerTool("read_big", { inputSchema: { id: z.number() } }, ({ id }) => {
        count("read_big");
        return { content: [{ type: "text", text: JSON.stringify({ id, value: "x".repeat(2000) }) }] };
      });
      server.registerTool("delete_thing", { inputSchema: { id: z.number() } }, ({ id }) => {
        count("delete_thing");
        return { content: [{ type: "text", text: JSON.stringify({ id, deleted: true }) }] };
      });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      void server.connect(serverT);
      return clientT;
    };
    return { calls, connect };
  }

  const packWith = (capture: string): PackEntry[] => [{
    tool: "delete_thing",
    capture: { tool: capture, args: { id: "$.args.id" } },
    inverse: { tool: "restore_thing", args: { id: "$.pre_state.id", value: "$.pre_state.value" } },
  }];

  async function overFake(extra: Record<string, unknown>, packs: PackEntry[], opts: Record<string, unknown> = {}, ledgerOpts: Record<string, unknown> = {}) {
    const f = fake();
    const ledger = new Ledger(join(dir, "ledger.db"), ledgerOpts);
    const config = parseConfig({ servers: { fake: { command: "unused" } }, ...extra });
    const proxy = new SagazProxy(config, { log: () => {}, ledger, connect: f.connect, packs: packOf(packs), ...opts });
    await proxy.start();
    const client = await connectClient(proxy);
    const close = async () => {
      await client.close();
      await proxy.close();
      ledger.close();
    };
    return { ...f, ledger, proxy, client, close };
  }

  it("capture timeout: the agent gets its result on time, the ledger counts the no-plan", async () => {
    const t = await overFake({}, packWith("read_hangs"), { captureTimeoutMs: 100 });
    try {
      const r = (await t.client.callTool({ name: "delete_thing", arguments: { id: 7 } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r))).toEqual({ id: 7, deleted: true });
      expect(t.calls).toMatchObject({ read_hangs: 1, delete_thing: 1 });

      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ status: "ok", undo_status: "none", pre_state_json: null });
      expect(undoOf(row!)).toMatchObject({ kind: "no_plan", reason: expect.stringMatching(/read_hangs.*[Tt]ime/s) });
    } finally {
      await t.close();
    }
  });

  it("capture tool answers isError: same story, with the tool's own message as the reason", async () => {
    const t = await overFake({}, packWith("read_fails"));
    try {
      const r = (await t.client.callTool({ name: "delete_thing", arguments: { id: 7 } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ undo_status: "none", pre_state_json: null });
      expect(undoOf(row!)).toMatchObject({ kind: "no_plan", reason: expect.stringContaining("reader exploded") });
    } finally {
      await t.close();
    }
  });

  it("capture-after-gates: a blocked call captures nothing — no read runs, no pre-state, no plan", async () => {
    const t = await overFake({ policy: { tools: [{ tool: "delete_thing", action: "block", reason: "not today" }] } }, packWith("read_thing"));
    try {
      const r = (await t.client.callTool({ name: "delete_thing", arguments: { id: 7 } })) as CallToolResult;
      expect(r.isError).toBe(true);
      expect(t.calls).toEqual({}); // neither the capture read nor the mutation reached the downstream
      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ status: "blocked", undo_status: "none", pre_state_json: null, undo_json: null });
    } finally {
      await t.close();
    }
  });

  it("preview: mutations run dry and the capture hook stays off", async () => {
    const t = await overFake({ preview: true }, packWith("read_thing"));
    try {
      const r = (await t.client.callTool({ name: "delete_thing", arguments: { id: 7 } })) as CallToolResult;
      expect(text(r)).toContain("recorded but NOT executed");
      expect(t.calls).toEqual({});
      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ status: "dry", undo_status: "none", pre_state_json: null, undo_json: null });
    } finally {
      await t.close();
    }
  });

  it("an oversized derived plan is refused whole — no truncated inverses; the no-plan and the capped pre-state say why", async () => {
    const packs: PackEntry[] = [{
      tool: "delete_thing",
      capture: { tool: "read_big", args: { id: "$.args.id" } },
      inverse: { tool: "restore_thing", args: { id: "$.pre_state.id", value: "$.pre_state.value" } },
    }];
    const t = await overFake({ ledger: { maxResultBytes: 256 } }, packs, {}, { maxResultBytes: 256 });
    try {
      const r = (await t.client.callTool({ name: "delete_thing", arguments: { id: 7 } })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ status: "ok", undo_status: "none" });
      expect(undoOf(row!)).toMatchObject({ kind: "no_plan", reason: expect.stringContaining("over ledger.maxResultBytes (256)") });
      // The stored pre-state was capped by the same limit: what the ledger keeps is marked, never silently cut.
      expect(JSON.parse(row!.pre_state_json ?? "")).toHaveProperty("$truncated");
      expect(t.ledger.verifySession(t.proxy.currentSessionId as string)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("a successful effect whose downstream call errors gets no plan: nothing happened to undo", async () => {
    // delete_thing with a string id fails zod validation downstream → the tool call errors.
    const t = await overFake({}, packWith("read_thing"));
    try {
      const r = (await t.client.callTool({ name: "delete_thing", arguments: { id: "not-a-number" } })) as CallToolResult;
      expect(r.isError).toBe(true);
      const [row] = t.ledger.listEffects(t.proxy.currentSessionId as string);
      expect(row).toMatchObject({ status: "error", undo_status: "none", undo_json: null });
    } finally {
      await t.close();
    }
  });
});

describe("ledger guards for the T10 columns", () => {
  it("setPreState only lands on a pending effect, once; setUndo only on a closed one; neither breaks the chain", () => {
    const ledger = new Ledger(join(dir, "guard.db"));
    const s = ledger.openSession({});
    const id = ledger.begin({ sessionId: s.id, server: "srv", tool: "t", args: { a: 1 } });
    ledger.setPreState(id, { content: [] });
    expect(() => ledger.setPreState(id, {})).toThrow(/already has a pre-state/);
    expect(() => ledger.setUndo(id, { undoStatus: "planned", undoJson: {} })).toThrow(/still pending/);
    ledger.end(id, { status: "ok", result: {} });
    expect(() => ledger.setPreState(id, {})).toThrow(/already closed/);
    ledger.setUndo(id, { undoStatus: "planned", undoJson: { kind: "tool_call", server: "srv", tool: "u", args: {} } });
    expect(ledger.get(id)).toMatchObject({ undo_status: "planned", pre_state_json: JSON.stringify({ content: [] }) });
    // undo columns live outside the hash: the lifecycle write leaves the chain intact.
    expect(ledger.verifySession(s.id)).toMatchObject({ ok: true });
    // undoJson omitted keeps the plan; null clears it to SQL NULL (not the JSON text "null").
    ledger.setUndo(id, { undoStatus: "failed" });
    expect(ledger.get(id)).toMatchObject({ undo_status: "failed", undo_json: expect.stringContaining("tool_call") });
    ledger.setUndo(id, { undoStatus: "none", undoJson: null });
    expect(ledger.get(id)).toMatchObject({ undo_status: "none", undo_json: null });
    expect(() => ledger.setUndo("nope", { undoStatus: "none" })).toThrow(/not found/);
    ledger.close();
  });
});

describe("pack matching (undo/packs)", () => {
  it("honours the optional server restriction; an unscoped entry matches any server, first match wins", () => {
    const entries: PackEntry[] = [
      { tool: "t", server: "a", inverse: { tool: "u", args: {} } },
      { tool: "t", inverse: { tool: "v", args: {} } },
    ];
    expect(matchPackEntry(entries, "t", "a")?.inverse.tool).toBe("u");
    expect(matchPackEntry(entries, "t", "b")?.inverse.tool).toBe("v");
    expect(matchPackEntry([entries[0]!], "t", "b")).toBeUndefined();
    expect(matchPackEntry(entries, "other", "a")).toBeUndefined();
  });
});

describe("reference resolution (undo/packs)", () => {
  const scope = { args: { id: 7, nested: { deep: "x" } }, result: { id: 9, company: null }, pre_state: undefined };

  it("resolves $.args / $.result paths, keeps null, drops undefined leaves", () => {
    expect(resolveReference("$.args.id", scope)).toBe(7);
    expect(resolveReference("$.args.nested.deep", scope)).toBe("x");
    expect(resolveReference("$.result.company", scope)).toBeNull();
    expect(mapArgs({ a: "$.args.id", b: "$.result.company", c: "$.result.missing" }, scope)).toEqual({ a: 7, b: null });
  });

  it("rejects bad references and missing roots with a PathError that says why", () => {
    expect(() => resolveReference("$.pre_state.name", scope)).toThrow(/no pre-state was captured/);
    expect(() => resolveReference("args.id", scope)).toThrow(PathError);
    expect(() => resolveReference("$.env.HOME", scope)).toThrow(PathError);
    expect(() => resolveReference("$.args.id.deeper", scope)).toThrow(/non-object/);
  });

  it("payloadOf prefers structuredContent, falls back to parsed text, and never throws", () => {
    expect(payloadOf({ structuredContent: { a: 1 }, content: [{ type: "text", text: "{\"b\":2}" }] })).toEqual({ a: 1 });
    expect(payloadOf({ content: [{ type: "text", text: "{\"b\":2}" }] })).toEqual({ b: 2 });
    expect(payloadOf({ content: [{ type: "text", text: "not json" }] })).toBeUndefined();
    expect(payloadOf({ content: [] })).toBeUndefined();
    expect(payloadOf(null)).toBeUndefined();
  });
});
