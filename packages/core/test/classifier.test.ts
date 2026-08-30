import { describe, expect, it } from "vitest";
import { classify, globToRegExp, leadingVerb, matchHeuristic, HEURISTICS } from "../src/classifier/index.js";
import { parseConfig } from "../src/config.js";

describe("leadingVerb", () => {
  it("normalises namespaces, prefixes and camelCase down to the first word", () => {
    expect(leadingVerb("send_email")).toBe("send");
    expect(leadingVerb("gmail.sendEmail")).toBe("send");
    expect(leadingVerb("toybox__list_contacts")).toBe("list");
    expect(leadingVerb("DropTable")).toBe("drop");
    expect(leadingVerb("ns/transfer-funds")).toBe("transfer");
    expect(leadingVerb("ping")).toBe("ping");
  });
});

describe("built-in heuristics", () => {
  it("has no verb in two rows", () => {
    const all = HEURISTICS.flatMap((r) => r.verbs);
    expect(new Set(all).size).toBe(all.length);
  });
  it.each([
    ["list_contacts", "read"], ["get_user", "read"], ["search_docs", "read"],
    ["create_contact", "R"],
    ["send_email", "C"], ["post_tweet", "C"], ["publish_release", "C"], ["notify_team", "C"],
    ["transfer_funds", "I"], ["pay_invoice", "I"], ["charge_card", "I"], ["execute_sql", "I"], ["drop_table", "I"],
    ["update_contact", "unknown"], ["delete_contact", "unknown"], ["delete_tweet", "unknown"], ["remove_member", "unknown"],
  ])("%s → %s", (tool, cls) => {
    expect(matchHeuristic(tool)?.class).toBe(cls);
  });
  it("never yields R for anything but create_*", () => {
    for (const row of HEURISTICS) if (row.class === "R") expect(row.verbs).toEqual(["create"]);
  });
  it("compound names that start with a read verb but contain a mutating one → unknown", () => {
    expect(matchHeuristic("get_or_create_user")).toMatchObject({ class: "unknown", reason: expect.stringContaining("create") });
    expect(matchHeuristic("search_and_destroy")?.class).toBe("unknown");
    expect(matchHeuristic("listAndDelete")?.class).toBe("unknown");
    expect(matchHeuristic("get_sent_items")?.class).toBe("read"); // "sent" is not a verb in the table
  });
  it("returns undefined for an unrecognised verb", () => {
    expect(matchHeuristic("frobnicate_widget")).toBeUndefined();
  });
});

describe("globToRegExp", () => {
  it("treats * as the only wildcard and escapes everything else", () => {
    expect(globToRegExp("delete_*").test("delete_contact")).toBe(true);
    expect(globToRegExp("delete_*").test("undelete_contact")).toBe(false);
    expect(globToRegExp("*_draft").test("save_draft")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("send_email").test("send_emails")).toBe(false);
  });
});

describe("classify cascade", () => {
  it("level 4: unknown when nothing matches, with a reason that names the tool", () => {
    expect(classify({ tool: "frobnicate", server: "s" })).toEqual({
      class: "unknown", source: "rule", reason: expect.stringContaining('"frobnicate"'),
    });
  });
  it("level 3: heuristics classify by name, source 'rule'", () => {
    expect(classify({ tool: "transfer_funds", server: "toybox" })).toMatchObject({ class: "I", source: "rule" });
    expect(classify({ tool: "list_timeline", server: "toybox" })).toMatchObject({ class: "read", source: "rule" });
    expect(classify({ tool: "delete_contact", server: "toybox" })).toMatchObject({ class: "unknown", source: "rule" });
  });
  it("level 2: readOnlyHint beats heuristics", () => {
    expect(classify({ tool: "transfer_funds", server: "s", annotations: { readOnlyHint: true } })).toMatchObject({ class: "read", source: "annotation" });
    expect(classify({ tool: "list_x", server: "s", annotations: { readOnlyHint: false } })).toMatchObject({ class: "read", source: "rule" });
  });
  it("destructiveHint is a cap, not a class: create_* + destructiveHint → unknown", () => {
    expect(classify({ tool: "create_thing", server: "s", annotations: { destructiveHint: true } })).toMatchObject({ class: "unknown", source: "annotation" });
    expect(classify({ tool: "send_email", server: "s", annotations: { destructiveHint: true } })).toMatchObject({ class: "C", source: "rule" });
    expect(classify({ tool: "delete_x", server: "s", annotations: { destructiveHint: true } })).toMatchObject({ class: "unknown" });
  });
  it("level 1: user rules ALWAYS win — over annotations and heuristics", () => {
    const rules = parseConfig({ servers: { s: { command: "x" } }, rules: [
      { tool: "transfer_funds", class: "read", reason: "sandbox account, fake money" },
      { tool: "delete_*", server: "s", class: "R" },
      { tool: "list_*", class: "I" },
    ] }).rules;
    expect(classify({ tool: "transfer_funds", server: "s", rules })).toEqual({ class: "read", source: "user", reason: "sandbox account, fake money" });
    expect(classify({ tool: "list_contacts", server: "s", annotations: { readOnlyHint: true }, rules })).toMatchObject({ class: "I", source: "user" });
    expect(classify({ tool: "delete_contact", server: "s", rules })).toEqual({ class: "R", source: "user", reason: "user rule s/delete_* → R" });
    // server-scoped rule does not leak to another server
    expect(classify({ tool: "delete_contact", server: "other", rules })).toMatchObject({ class: "unknown", source: "rule" });
  });
  it("first matching rule in file order wins", () => {
    const rules = parseConfig({ servers: { s: { command: "x" } }, rules: [
      { tool: "send_*", class: "I" }, { tool: "send_email", class: "C" },
    ] }).rules;
    expect(classify({ tool: "send_email", server: "s", rules }).class).toBe("I");
  });
});

describe("classify level 2 (T11): compensation packs", () => {
  const packs = [{
    name: "crm",
    description: "CRM inverses",
    entries: [
      { tool: "delete_contact", capture: { tool: "get_contact", args: { id: "$.args.id" } }, inverse: { tool: "create_contact", args: { id: "$.pre_state.id" } } },
      { tool: "create_contact", inverse: { tool: "delete_contact", args: { id: "$.result.id" } } },
      { tool: "wipe_all", server: "elsewhere", inverse: { tool: "restore_all", args: {} } },
    ],
  }];

  it("a pack entry → R with source 'pack' and a reason citing the pack and the inverse", () => {
    expect(classify({ tool: "delete_contact", server: "s", packs })).toEqual({
      class: "R", source: "pack", reason: 'compensation pack "crm": inverse create_contact from the captured pre-state',
    });
    expect(classify({ tool: "create_contact", server: "s", packs })).toMatchObject({ class: "R", source: "pack", reason: expect.stringContaining("from the result") });
  });
  it("the destructiveHint cap does NOT apply to an R by pack — the cap existed because the inverse was unknown", () => {
    expect(classify({ tool: "delete_contact", server: "s", annotations: { destructiveHint: true }, packs })).toMatchObject({ class: "R", source: "pack" });
  });
  it("user rules still ALWAYS win — over packs too", () => {
    const rules = parseConfig({ servers: { s: { command: "x" } }, rules: [{ tool: "delete_contact", class: "I", reason: "not in my house" }] }).rules;
    expect(classify({ tool: "delete_contact", server: "s", rules, packs })).toEqual({ class: "I", source: "user", reason: "not in my house" });
  });
  it("a server-scoped entry does not leak; no packs (or no match) falls through the cascade as before", () => {
    expect(classify({ tool: "wipe_all", server: "s", packs })).toMatchObject({ class: "I", source: "rule" }); // heuristic wipe_* → I
    expect(classify({ tool: "wipe_all", server: "elsewhere", packs })).toMatchObject({ class: "R", source: "pack" });
    expect(classify({ tool: "delete_contact", server: "s" })).toMatchObject({ class: "unknown", source: "rule" });
  });
});

describe("rules in sagaz.config.json", () => {
  it("defaults to none and validates class and server", () => {
    expect(parseConfig({ servers: { s: { command: "x" } } }).rules).toEqual([]);
    expect(() => parseConfig({ servers: { s: { command: "x" } }, rules: [{ tool: "a", class: "maybe" }] })).toThrow(/rules\.0\.class/);
    expect(() => parseConfig({ servers: { s: { command: "x" } }, rules: [{ tool: "a", class: "R", server: "bad name" }] })).toThrow(/rules\.0\.server/);
  });
});
