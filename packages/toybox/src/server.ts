/**
 * MCP server exposing the toybox world as tools.
 *
 * Annotations are DELIBERATELY mixed: some tools carry correct MCP hints
 * (readOnlyHint / destructiveHint / idempotentHint), others carry none, so the
 * Phase 1 classifier can be tested on both paths. See README.md for the table.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { World, WorldError } from "./world.js";

export const SERVER_NAME = "sagaz-toybox";
function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof WorldError ? err.message : err instanceof Error ? `Internal error: ${err.message}` : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wrap a handler so WorldError becomes a tool error result instead of a protocol error. */
function tool<T>(fn: (args: T) => unknown): (args: T) => CallToolResult {
  return (args) => {
    try {
      return ok(fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function createToyboxServer(world: World, opts: { version?: string } = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: opts.version ?? "0.0.0" });

  // ---- CRM (type R) --------------------------------------------------------

  server.registerTool(
    "list_contacts",
    {
      description: "List all CRM contacts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(() => world.listContacts()),
  );

  server.registerTool(
    "get_contact",
    {
      description: "Fetch a single CRM contact by id.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    tool(({ id }) => world.getContact(id)),
  );

  server.registerTool(
    "create_contact",
    {
      description: "Create a CRM contact. Email must be unique. company may be null (no company).",
      inputSchema: { name: z.string().min(1), email: z.string().email(), company: z.string().nullable().optional() },
      // no annotations on purpose
    },
    tool((a) => world.createContact(a)),
  );

  server.registerTool(
    "update_contact",
    {
      description: "Update fields of an existing CRM contact by id. Pass company: null to clear it.",
      inputSchema: {
        id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        company: z.string().nullable().optional(),
      },
      // no annotations on purpose
    },
    tool(({ id, ...patch }) => world.updateContact(id, patch)),
  );

  server.registerTool(
    "delete_contact",
    {
      description: "Delete a CRM contact by id.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    tool(({ id }) => world.deleteContact(id)),
  );

  // ---- Comms (type C) ------------------------------------------------------

  server.registerTool(
    "send_email",
    {
      description: "Send an email. Once sent it cannot be unsent; a correction can be sent with in_reply_to.",
      inputSchema: {
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string(),
        in_reply_to: z.number().int().positive().optional(),
      },
      // no annotations on purpose — the classifier must infer from the name
    },
    tool((a) => world.sendEmail({ to: a.to, subject: a.subject, body: a.body, inReplyTo: a.in_reply_to })),
  );

  server.registerTool(
    "list_inbox",
    {
      description: "List all emails sent so far.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(() => world.listInbox()),
  );

  server.registerTool(
    "post_tweet",
    {
      description: "Post a public tweet (max 280 chars).",
      inputSchema: { text: z.string().min(1).max(280) },
      // no annotations on purpose
    },
    tool(({ text }) => world.postTweet(text)),
  );

  server.registerTool(
    "delete_tweet",
    {
      description: "Delete a tweet from the public timeline.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    tool(({ id }) => world.deleteTweet(id)),
  );

  server.registerTool(
    "list_timeline",
    {
      description: "List tweets currently visible on the timeline.",
      inputSchema: {},
      // read-only, but NO readOnlyHint on purpose — the classifier must infer it
    },
    tool(() => world.listTimeline()),
  );

  // ---- Bank (type I) -------------------------------------------------------

  server.registerTool(
    "list_accounts",
    {
      description: "List bank accounts with their current balances (in cents).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(() => world.listAccounts()),
  );

  server.registerTool(
    "transfer_funds",
    {
      description:
        "Transfer money between accounts (acc-ops, acc-payroll, acc-vendor). Amount in cents. This cannot be reversed.",
      inputSchema: {
        from_account: z.string().min(1),
        to_account: z.string().min(1),
        amount_cents: z.number().int().positive(),
        memo: z.string().optional(),
      },
      // no annotations on purpose — the trap: nothing in the metadata says "irreversible"
    },
    tool((a) => world.transferFunds({ from: a.from_account, to: a.to_account, amountCents: a.amount_cents, memo: a.memo })),
  );

  return server;
}
