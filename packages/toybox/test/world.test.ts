import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World, WorldError, fmtMoney } from "../src/world.js";

let dir: string;
let world: World;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toybox-"));
  world = new World(join(dir, "w.db"), { clock: () => "2026-02-02T10:00:00.000Z" });
  world.seed();
});
afterEach(() => {
  world.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("seed", () => {
  it("is deterministic and idempotent", () => {
    const first = world.inspect();
    world.createContact({ name: "X", email: "x@x.io" });
    world.seed();
    expect(world.inspect()).toBe(first);
    expect(world.listContacts().map((c) => c.email)).toEqual(["ada@analytical.engine", "grace@cobol.navy", "linus@kernel.org"]);
    expect(world.listAccounts().map((a) => a.balance_cents)).toEqual([500_000, 1_000_000, 0]);
  });
});

describe("CRM (type R)", () => {
  it("create → update → delete round-trips", () => {
    const c = world.createContact({ name: "Alan Turing", email: "alan@bletchley.uk" });
    expect(c.id).toBe(4);
    expect(world.updateContact(c.id, { company: "GCHQ" }).company).toBe("GCHQ");
    expect(world.updateContact(c.id, { company: null }).company).toBeNull();
    expect(world.deleteContact(c.id).email).toBe("alan@bletchley.uk");
    expect(world.listContacts()).toHaveLength(3);
  });
  it("rejects duplicate emails and unknown ids", () => {
    expect(() => world.createContact({ name: "Dup", email: "ada@analytical.engine" })).toThrow(WorldError);
    expect(() => world.deleteContact(999)).toThrow(/not found/);
    expect(() => world.updateContact(2, { email: "ada@analytical.engine" })).toThrow(/already exists/);
    expect(world.updateContact(2, { email: "grace@cobol.navy" }).email).toBe("grace@cobol.navy");
  });
});

describe("comms (type C)", () => {
  it("sends emails, including replies", () => {
    const e = world.sendEmail({ to: "grace@cobol.navy", subject: "Hi", body: "…" });
    const r = world.sendEmail({ to: "grace@cobol.navy", subject: "Re: Hi", body: "correction", inReplyTo: e.id });
    expect(r.in_reply_to).toBe(e.id);
    expect(world.listInbox()).toHaveLength(3);
  });
  it("soft-deletes tweets: hidden from timeline, kept for inspection", () => {
    const t = world.postTweet("oops");
    world.deleteTweet(t.id);
    expect(world.listTimeline().map((x) => x.id)).toEqual([1]);
    expect(world.inspect()).toContain("[DELETED] oops");
    expect(() => world.deleteTweet(t.id)).toThrow(/already deleted/);
  });
});

describe("bank (type I)", () => {
  it("moves money atomically and logs the transfer", () => {
    const t = world.transferFunds({ from: "acc-ops", to: "acc-vendor", amountCents: 125_00, memo: "invoice 42" });
    expect(t.amount_cents).toBe(12_500);
    const [ops, , vendor] = world.listAccounts();
    expect(ops?.balance_cents).toBe(487_500);
    expect(vendor?.balance_cents).toBe(12_500);
  });
  it("rejects insufficient funds without partial writes", () => {
    expect(() => world.transferFunds({ from: "acc-vendor", to: "acc-ops", amountCents: 1 })).toThrow(/Insufficient/);
    expect(() => world.transferFunds({ from: "acc-ops", to: "acc-ops", amountCents: 1 })).toThrow(/same account/);
    expect(() => world.transferFunds({ from: "acc-ops", to: "acc-nope", amountCents: 1 })).toThrow(/not found/);
    expect(world.listTransfers()).toHaveLength(0);
    expect(world.listAccounts().map((a) => a.balance_cents)).toEqual([500_000, 1_000_000, 0]);
  });
  it("formats money", () => {
    expect(fmtMoney(1_234_567)).toBe("$12,345.67");
    expect(fmtMoney(5)).toBe("$0.05");
  });
});
