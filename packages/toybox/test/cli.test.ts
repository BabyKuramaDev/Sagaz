import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (!existsSync(bin)) {
  throw new Error(`toybox bin not built (${bin}). Run \`pnpm build\` before \`pnpm test\`.`);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toybox-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): string {
  return execFileSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, TOYBOX_DB: join(dir, "world.db") },
  });
}

describe("sagaz-toybox bin", () => {
  it("prints a version", () => {
    expect(run("--version").trim()).toMatch(/^sagaz-toybox \d+\.\d+\.\d+$/);
  });

  it("seed then inspect shows the deterministic world at $TOYBOX_DB", () => {
    expect(run("seed")).toContain("Seeded ");
    const out = run("inspect");
    expect(out).toContain("== CONTACTS (3) ==");
    expect(out).toContain("Ada Lovelace <ada@analytical.engine>");
    expect(out).toMatch(/acc-payroll\s+Payroll\s+\$10,000\.00/);
    expect(out).toContain("== TRANSFERS (0) — irreversible ==");
    expect(existsSync(join(dir, "world.db"))).toBe(true);
  });
});
