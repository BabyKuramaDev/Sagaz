import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("@sagaz/core", () => {
  it("exposes a semver-shaped version", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
