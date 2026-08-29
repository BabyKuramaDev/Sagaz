import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));

if (!existsSync(bin)) {
  throw new Error(`CLI bin not built (${bin}). Run \`pnpm build\` before \`pnpm test\`.`);
}

describe("sagaz bin", () => {
  it("prints a version and exits 0", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^sagaz \d+\.\d+\.\d+ \(core \d+\.\d+\.\d+\)$/);
  });

  it("exits 1 on an unknown argument", () => {
    expect(() =>
      execFileSync(process.execPath, [bin, "--bogus"], { encoding: "utf8", stdio: "pipe" }),
    ).toThrow(/Unknown argument/);
  });
});
