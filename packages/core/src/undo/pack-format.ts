/**
 * The compensation pack format — a PUBLIC contract. People write these JSON files by hand for
 * their own MCP servers, so validation is strict (unknown keys are typos, not extensions) and
 * every error names the exact field and what was expected. Example:
 *
 *   {
 *     "name": "toybox-crm",
 *     "description": "Deterministic inverses for the toybox CRM",
 *     "entries": [
 *       {
 *         "tool": "delete_contact",              // exact name or glob (*), optional "server"
 *         "note": "why this is the inverse",     // optional, for humans
 *         "capture": { "tool": "get_contact", "args": { "id": "$.args.id" } },
 *         "inverse": { "tool": "create_contact", "args": { "id": "$.pre_state.id", "...": "..." } }
 *       }
 *     ]
 *   }
 *
 * `capture` args can only reference `$.args.*` (nothing else exists before the call runs);
 * `inverse` args reference `$.args.*`, `$.result.*` and `$.pre_state.*`. Loaded from
 * `"packs": [...]` in sagaz.config.json — inline objects or paths relative to the config file
 * (see config.ts). The official toybox pack lives at packages/toybox/sagaz-pack.json.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CompensationPack } from "./packs.js";

const IDENT = /^[A-Za-z0-9_-]+$/;
const REFERENCE = /^\$\.(args|result|pre_state)((?:\.[A-Za-z0-9_-]+)*)$/;

/** One arg value: a `$.…` reference restricted to the roots that exist at that point. */
function reference(roots: readonly string[]): z.ZodString {
  return z.string().superRefine((value, ctx) => {
    const m = REFERENCE.exec(value);
    if (!m) {
      ctx.addIssue({
        code: "custom",
        message: `"${value}" is not a reference — expected ${roots.map((r) => `$.${r}.x`).join(" or ")} (segments of letters, digits, _ or -)`,
      });
    } else if (!roots.includes(m[1] as string)) {
      ctx.addIssue({ code: "custom", message: `"${value}" reads $.${m[1]}, which does not exist here — this mapping can only reference ${roots.map((r) => `$.${r}.*`).join(", ")}` });
    }
  });
}

const CaptureSpecSchema = z.strictObject({
  tool: z.string().min(1, "the capture tool name cannot be empty"),
  // The capture runs BEFORE the call is forwarded: no result, no pre-state exist yet.
  args: z.record(z.string(), reference(["args"])),
});

const InverseSpecSchema = z.strictObject({
  tool: z.string().min(1, "the inverse tool name cannot be empty"),
  args: z.record(z.string(), reference(["args", "result", "pre_state"])),
});

const PackEntrySchema = z.strictObject({
  tool: z.string().min(1, "the tool to match cannot be empty (exact name or glob with *)"),
  server: z.string().regex(IDENT, "server must match [A-Za-z0-9_-]+ (the name you gave the server in sagaz.config.json)").optional(),
  capture: CaptureSpecSchema.optional(),
  inverse: InverseSpecSchema,
  note: z.string().min(1, "note, when present, cannot be empty").optional(),
});

const PackSchema = z.strictObject({
  name: z.string().regex(IDENT, "pack name must match [A-Za-z0-9_-]+ — it identifies the pack in `sagaz packs`, class_reason and errors"),
  description: z.string().min(1, "description cannot be empty — one line saying what the pack covers"),
  entries: z.array(PackEntrySchema).min(1, "a pack needs at least one entry"),
});

/** A compensation pack that does not validate. `message` already names the source and fields. */
export class PackError extends Error {
  override readonly name = "PackError";
}

/** Validates one pack. `source` names where it came from (file path, or `packs[i] of <config>`). */
export function parsePack(raw: unknown, source: string): CompensationPack {
  const result = PackSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new PackError(`Invalid compensation pack ${source}:\n${issues}`);
  }
  const pack = result.data;
  for (const [i, entry] of pack.entries.entries()) {
    // An inverse that reads $.pre_state needs a capture, or resolution is guaranteed to fail
    // at runtime — tell the author now, while the file is in front of them.
    if (!entry.capture) {
      const key = Object.entries(entry.inverse.args).find(([, ref]) => ref.startsWith("$.pre_state"))?.[0];
      if (key !== undefined) {
        throw new PackError(
          `Invalid compensation pack ${source}:\n  - entries.${i}.inverse.args.${key}: references $.pre_state but the entry declares no "capture" — nothing would ever be captured. Add a capture read, or map from $.args / $.result.`,
        );
      }
    }
  }
  return pack;
}

/** Reads and validates a pack file (already an absolute path; config.ts resolves it). */
export function loadPackFile(absPath: string): CompensationPack {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new PackError(`Cannot read compensation pack at ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PackError(`Compensation pack at ${absPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsePack(raw, absPath);
}
