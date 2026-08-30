/**
 * T10 reel — capture hook + undo plans, over the real toybox and the real CLI.
 *
 * Convention (T10 onwards): every ticket leaves its checkpoint reel here, versioned, so any
 * demo can be re-run byte-for-byte. Run from the repo root after `pnpm build`:
 *
 *     node examples/reels/t10-capture.mjs
 *
 * Scenes: (a) create_contact planned from the result alone, (b) delete_contact with the whole
 * contact captured before it dies, (c) a killed capture tool the agent never notices — the
 * ledger records the no-plan and why, (d) sagaz verify with the pre-states sealed in the hash.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SagazProxy, Ledger, parseConfig } from "../../packages/core/dist/index.js";

// The SDK is a workspace dependency of core, not of the repo root: resolve it from there.
const sdk = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const { Client } = await import(sdk.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(sdk.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const { InMemoryTransport } = await import(sdk.resolve("@modelcontextprotocol/sdk/inMemory.js"));

const TOYBOX = fileURLToPath(new URL("../../packages/toybox/dist/index.js", import.meta.url));
const SAGAZ = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const dir = mkdtempSync(join(process.env.REEL_DIR ?? tmpdir(), "t10-reel-"));
const db = join(dir, "toybox.db");
const configPath = join(dir, "sagaz.config.json");
writeFileSync(configPath, JSON.stringify({
  servers: { toybox: { command: process.execPath, args: [TOYBOX], env: { TOYBOX_DB: db } } },
  ledger: { path: "ledger.db" },
}, null, 2));

const toybox = (cmd) => execFileSync(process.execPath, [TOYBOX, cmd], { encoding: "utf8", env: { ...process.env, TOYBOX_DB: db } });
const sagaz = (...args) => execFileSync(process.execPath, [SAGAZ, "--config", configPath, ...args], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
const scene = (title) => console.log(`\n\x1b[1m━━━ ${title} ━━━\x1b[0m`);
const agentSees = (r) => console.log(`  agent got (isError: ${r.isError ?? false}): ${r.content[0].text.split("\n").join(" ").slice(0, 120)}`);

toybox("seed");
scene("the world, seeded");
console.log(toybox("inspect"));

// ---- scenes (a) + (b): through the real `sagaz serve` -------------------------------------
const client = new Client({ name: "reel-agent", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SAGAZ, "serve", "--config", configPath], stderr: "inherit" }));

scene("(a) agent: create_contact Alan Turing");
agentSees(await client.callTool({ name: "create_contact", arguments: { name: "Alan Turing", email: "alan@bletchley.uk" } }));

scene("(b) agent: delete_contact #2 (Grace Hopper)");
agentSees(await client.callTool({ name: "delete_contact", arguments: { id: 2 } }));
await client.close();
await new Promise((r) => setTimeout(r, 300)); // let the serve process release the ledger

// ---- scene (c): the capture tool was killed — the pack points at a tool that is gone ------
scene("(c) capture forced to fail: pack's capture read points at a killed tool");
const ledger = new Ledger(join(dir, "ledger.db"));
const proxy = new SagazProxy(
  parseConfig({ servers: { toybox: { command: process.execPath, args: [TOYBOX], env: { TOYBOX_DB: db } } } }),
  {
    ledger,
    log: (l) => console.log(`  ${l}`),
    packs: [{
      tool: "delete_contact",
      capture: { tool: "get_contact_KILLED", args: { id: "$.args.id" } },
      inverse: { tool: "create_contact", args: { name: "$.pre_state.name", email: "$.pre_state.email" } },
    }],
  },
);
await proxy.start();
const [ct, st] = InMemoryTransport.createLinkedPair();
await proxy.serve(st);
const agent2 = new Client({ name: "reel-agent-2", version: "1.0.0" });
await agent2.connect(ct);
agentSees(await agent2.callTool({ name: "delete_contact", arguments: { id: 3 } }));
console.log("  ↑ the agent saw a perfectly normal delete — no error, no delay, no hint of the failed capture");
await agent2.close();
await proxy.close();
const [s1, s2] = ledger.listSessions().map((s) => s.id);
ledger.close();

// ---- the ledger tells the whole story ------------------------------------------------------
scene("sagaz ledger — session 1 (scenes a+b): the undo column");
console.log(sagaz("ledger", "--session", s1));

scene("sagaz ledger --json — session 1: pre_state_json + undo_json in full");
for (const line of sagaz("ledger", "--json", "--session", s1).trim().split("\n")) {
  const r = JSON.parse(line);
  console.log(`  seq ${r.seq} ${r.tool} [${r.status}] undo_status=${r.undo_status}`);
  console.log(`    pre_state_json: ${r.pre_state_json ?? "null"}`);
  console.log(`    undo_json:      ${r.undo_json ?? "null"}`);
}

scene("sagaz ledger — session 2 (scene c): the no-plan, counted");
console.log(sagaz("ledger", "--session", s2));
const noPlanRow = sagaz("ledger", "--json", "--session", s2).trim().split("\n").map((l) => JSON.parse(l))[0];
console.log(`  undo_json: ${noPlanRow.undo_json}`);

scene("(d) sagaz verify — both sessions, pre-states inside the hash");
console.log(sagaz("verify", "--session", s1));
console.log(sagaz("verify", "--session", s2));

scene("sagaz status");
console.log(sagaz("status"));

scene("the world, after");
console.log(toybox("inspect"));
