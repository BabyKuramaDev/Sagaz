/**
 * T11 reel — compensation packs, over the real toybox, the real CLI and the OFFICIAL pack file.
 *
 * Convention (T10 onwards): every ticket leaves its checkpoint reel here, versioned, so any
 * demo can be re-run byte-for-byte. Run from the repo root after `pnpm build`:
 *
 *     node examples/reels/t11-packs.mjs
 *
 * Scenes: (a) `sagaz packs` — the toybox pack, its entries, and the uncovered tools as the
 * to-do list, (b) delete_contact lands as R via pack (goodbye unknown) with an undo plan that
 * restores IDENTITY (id from the captured pre-state), (c) a handwritten invalid pack rejected
 * with the exact field, (d) two packs covering the same tool refuse to start, (e) a pre-T11
 * ledger migrating on open (class_source CHECK rebuild, T0 §4d) with every chain verifying.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The SDK and better-sqlite3 are workspace dependencies of core, not of the repo root.
const core = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const { Client } = await import(core.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(core.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const { default: Database } = await import(core.resolve("better-sqlite3"));

const TOYBOX = fileURLToPath(new URL("../../packages/toybox/dist/index.js", import.meta.url));
const SAGAZ = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const OFFICIAL_PACK = fileURLToPath(new URL("../../packages/toybox/sagaz-pack.json", import.meta.url));
const dir = mkdtempSync(join(process.env.REEL_DIR ?? tmpdir(), "t11-reel-"));
const db = join(dir, "toybox.db");
const ledgerPath = join(dir, "ledger.db");
const configPath = join(dir, "sagaz.config.json");
const baseConfig = (packs) => ({
  servers: { toybox: { command: process.execPath, args: [TOYBOX], env: { TOYBOX_DB: db } } },
  ledger: { path: "ledger.db" },
  packs,
});
writeFileSync(configPath, JSON.stringify(baseConfig([OFFICIAL_PACK]), null, 2));

const toybox = (cmd) => execFileSync(process.execPath, [TOYBOX, cmd], { encoding: "utf8", env: { ...process.env, TOYBOX_DB: db } });
const sagaz = (...args) => execFileSync(process.execPath, [SAGAZ, "--config", configPath, ...args], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
const sagazFails = (...args) => {
  try {
    execFileSync(process.execPath, [SAGAZ, "--config", configPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
    throw new Error(`expected \`sagaz ${args.join(" ")}\` to fail`);
  } catch (err) {
    return { code: err.status, stderr: String(err.stderr ?? "") };
  }
};
const scene = (title) => console.log(`\n\x1b[1m━━━ ${title} ━━━\x1b[0m`);
const agentSees = (r) => console.log(`  agent got (isError: ${r.isError ?? false}): ${r.content[0].text.split("\n").join(" ").slice(0, 120)}`);

toybox("seed");
scene("the world, seeded");
console.log(toybox("inspect"));

// ---- scene (a): sagaz packs — what is covered, and the to-do list ---------------------------
scene("(a) sagaz packs — the official toybox pack and the coverage report");
console.log(sagaz("packs"));

// ---- scene (b): delete_contact is R via pack, and the plan restores identity ----------------
scene("(b) agent: delete_contact #2 (Grace Hopper) — through the real `sagaz serve`");
const client = new Client({ name: "reel-agent", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SAGAZ, "serve", "--config", configPath], stderr: "inherit" }));
agentSees(await client.callTool({ name: "delete_contact", arguments: { id: 2 } }));
await client.close();
await new Promise((r) => setTimeout(r, 300)); // let the serve process release the ledger

scene("sagaz ledger — class R, source pack: goodbye unknown");
console.log(sagaz("ledger"));
const row = JSON.parse(sagaz("ledger", "--json").trim().split("\n")[0]);
console.log(`  class=${row.class} class_source=${row.class_source}`);
console.log(`  class_reason: ${row.class_reason}`);
console.log(`  undo_json:    ${row.undo_json}`);
console.log("  ↑ the plan carries id: 2 — the inverse restores IDENTITY, not just content (create_contact restore semantics)");

// ---- scene (c): a handwritten pack with a typo — the error points at the field --------------
scene('(c) a handwritten pack: "$.result_id" is not a reference');
const typoPack = join(dir, "my-pack.json");
writeFileSync(typoPack, JSON.stringify({
  name: "my-pack",
  description: "my first pack",
  entries: [{ tool: "delete_thing", inverse: { tool: "restore_thing", args: { id: "$.result_id" } } }],
}, null, 2));
writeFileSync(configPath, JSON.stringify(baseConfig([OFFICIAL_PACK, "my-pack.json"]), null, 2));
console.log(sagazFails("packs").stderr);

// ---- scene (d): two packs covering the same tool — startup error, never magic ---------------
scene("(d) a second pack also covers delete_contact — sagaz refuses to start");
const rivalPack = join(dir, "rival.json");
writeFileSync(rivalPack, JSON.stringify({
  name: "rival",
  description: "also covers deletes",
  entries: [{ tool: "delete_*", inverse: { tool: "create_contact", args: { name: "$.pre_state.name" } }, capture: { tool: "get_contact", args: { id: "$.args.id" } } }],
}, null, 2));
writeFileSync(configPath, JSON.stringify(baseConfig([OFFICIAL_PACK, "rival.json"]), null, 2));
console.log(sagazFails("serve").stderr);
writeFileSync(configPath, JSON.stringify(baseConfig([OFFICIAL_PACK]), null, 2));

// ---- scene (e): a pre-T11 ledger migrates on open (T0 §4d) ----------------------------------
scene("(e) a T10 ledger meets T11: the class_source CHECK migrates by table rebuild");
// A T10 ledger first: a session run WITHOUT packs (its class_source values are all pre-'pack'),
// then the effects table rebuilt back to the frozen pre-T11 DDL — same rows, old CHECK:
// exactly what a ledger written by T10 looks like on disk.
const oldLedgerConfig = { ...baseConfig([]), ledger: { path: "old-ledger.db" } };
writeFileSync(configPath, JSON.stringify(oldLedgerConfig, null, 2));
const client0 = new Client({ name: "reel-agent-t10", version: "1.0.0" });
await client0.connect(new StdioClientTransport({ command: process.execPath, args: [SAGAZ, "serve", "--config", configPath], stderr: "inherit" }));
await client0.callTool({ name: "list_contacts", arguments: {} });
agentSees(await client0.callTool({ name: "update_contact", arguments: { id: 1, company: "Difference Engines Ltd" } }));
await client0.close();
await new Promise((r) => setTimeout(r, 300));
const oldLedgerPath = join(dir, "old-ledger.db");

const raw = new Database(oldLedgerPath);
raw.pragma("foreign_keys = OFF");
const newDdl = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'effects'").get().sql;
raw.exec(newDdl.replace(/CREATE TABLE (IF NOT EXISTS )?effects/, "CREATE TABLE effects_old").replace("'llm','user','pack'", "'llm','user'").replace("REFERENCES effects(id)", "REFERENCES effects_old(id)"));
raw.exec("INSERT INTO effects_old SELECT * FROM effects; DROP TABLE effects; ALTER TABLE effects_old RENAME TO effects");
const before = raw.prepare("SELECT COUNT(*) AS n FROM effects").get().n;
console.log(`  rebuilt to the pre-T11 DDL: ${before} row(s), CHECK is now (${raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'effects'").get().sql.match(/class_source[^)]*\)/)[0].replace(/\s+/g, " ")}`);
raw.close();

console.log("\n  … an agent runs through the NEW sagaz, packs on (the writable open migrates the table first):\n");
writeFileSync(configPath, JSON.stringify({ ...baseConfig([OFFICIAL_PACK]), ledger: { path: "old-ledger.db" } }, null, 2));
const client2 = new Client({ name: "reel-agent-2", version: "1.0.0" });
await client2.connect(new StdioClientTransport({ command: process.execPath, args: [SAGAZ, "serve", "--config", configPath], stderr: "inherit" }));
agentSees(await client2.callTool({ name: "delete_contact", arguments: { id: 3 } }));
await client2.close();
await new Promise((r) => setTimeout(r, 300));

const check = new Database(oldLedgerPath, { readonly: true });
const after = check.prepare("SELECT COUNT(*) AS n FROM effects").get().n;
const sources = check.prepare("SELECT class_source, COUNT(*) AS n FROM effects GROUP BY class_source ORDER BY class_source").all();
console.log(`  migrated: ${after} row(s) (${before} old + ${after - before} new), CHECK admits 'pack': ${check.prepare("SELECT sql FROM sqlite_master WHERE name = 'effects'").get().sql.includes("'pack'")}`);
console.log(`  class_source counts: ${sources.map((s) => `${s.class_source}=${s.n}`).join("  ")}`);
check.close();

scene("sagaz verify — the pre-migration chain and the new one, both intact");
console.log(sagaz("status"));
const ledgerDb = new Database(oldLedgerPath, { readonly: true });
const ids = ledgerDb.prepare("SELECT id FROM sessions ORDER BY id").all().map((s) => s.id);
ledgerDb.close();
for (const id of ids) console.log(sagaz("verify", "--session", id));

scene("the world, after");
console.log(toybox("inspect"));
