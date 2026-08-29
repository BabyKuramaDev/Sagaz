import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToyboxServer } from "../src/server.js";
import { World } from "../src/world.js";

let dir: string;
let world: World;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "toybox-srv-"));
  world = new World(join(dir, "w.db"));
  world.seed();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createToyboxServer(world).connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
});
afterEach(async () => {
  await client.close();
  world.close();
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_TOOLS = [
  "list_contacts", "create_contact", "update_contact", "delete_contact",
  "send_email", "list_inbox", "post_tweet", "delete_tweet", "list_timeline",
  "transfer_funds",
];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
function text(r: CallToolResult): string {
  const first = r.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("toybox MCP server", () => {
  it("lists exactly the documented tools with the documented (mixed) annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName["list_contacts"]?.readOnlyHint).toBe(true);
    expect(byName["delete_contact"]?.destructiveHint).toBe(true);
    expect(byName["delete_tweet"]?.destructiveHint).toBe(true);
    expect(byName["list_inbox"]?.readOnlyHint).toBe(true);
    for (const unannotated of ["create_contact", "update_contact", "send_email", "post_tweet", "list_timeline", "transfer_funds"]) {
      expect(byName[unannotated], unannotated).toBeUndefined();
    }
  });

  it("runs the reel sequence: create_contact → send_email → transfer_funds, visible in the DB", async () => {
    const c = await call("create_contact", { name: "Alan Turing", email: "alan@bletchley.uk", company: "GCHQ" });
    expect(c.isError).toBeFalsy();
    expect(JSON.parse(text(c)).id).toBe(4);

    const e = await call("send_email", { to: "alan@bletchley.uk", subject: "Welcome", body: "Hi Alan" });
    expect(JSON.parse(text(e)).to_addr).toBe("alan@bletchley.uk");

    const t = await call("transfer_funds", { from_account: "acc-payroll", to_account: "acc-vendor", amount_cents: 250_000 });
    expect(JSON.parse(text(t)).amount_cents).toBe(250_000);

    // The world is inspectable from outside the agent.
    const dump = world.inspect();
    expect(dump).toContain("Alan Turing <alan@bletchley.uk>");
    expect(dump).toContain('to alan@bletchley.uk  "Welcome"');
    expect(dump).toContain("acc-payroll -> acc-vendor  $2,500.00");
  });

  it("covers the remaining tools end to end", async () => {
    expect(JSON.parse(text(await call("update_contact", { id: 1, company: null }))).company).toBeNull();
    expect(JSON.parse(text(await call("delete_contact", { id: 3 }))).name).toBe("Linus Torvalds");
    expect(JSON.parse(text(await call("list_contacts")))).toHaveLength(2);
    const tw = JSON.parse(text(await call("post_tweet", { text: "we shipped" })));
    expect(JSON.parse(text(await call("list_timeline")))).toHaveLength(2);
    expect(JSON.parse(text(await call("delete_tweet", { id: tw.id }))).deleted_at).toBeTruthy();
    expect(JSON.parse(text(await call("list_timeline")))).toHaveLength(1);
    expect(JSON.parse(text(await call("list_inbox")))).toHaveLength(1);
  });

  it("returns world errors as tool errors, not protocol errors", async () => {
    const r = await call("transfer_funds", { from_account: "acc-vendor", to_account: "acc-ops", amount_cents: 100 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Insufficient funds/);
  });

  it("rejects invalid input via schema validation", async () => {
    const r = await call("create_contact", { name: "No Email", email: "not-an-email" });
    expect(r.isError).toBe(true);
  });
});
