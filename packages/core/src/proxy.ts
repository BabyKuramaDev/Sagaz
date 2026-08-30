/**
 * The Sagaz interceptor: an MCP server towards the client, an MCP client towards each
 * downstream server. Transparent pass-through of tools/list and tools/call; every call is
 * classified (R/C/I, see classifier/), gated by policy (see policy/) and recorded in the
 * effect ledger — blocked attempts included. Per call the order is: classify → policy/gates →
 * capture hook (pack pre-state read, see undo/) → forward → close → derive undo plan.
 *
 * Preview mode (`sagaz serve --preview` / `"preview": true`) runs the whole session dry: a call
 * whose class is `read` (by the full cascade) is forwarded as usual so the agent can still see
 * the world and plan; every other class — R, C, I and `unknown` — is recorded as 'dry' and
 * answered with a spoken note, never forwarded. The policy does not run in preview: nothing
 * executes, so there is nothing to confirm or block. Honest edge: a mutating tool wrongly
 * classified `read` (a lying `readOnlyHint`, or a user rule) WOULD run — which is why `unknown`
 * is not forwarded. When in doubt, dry.
 *
 * Tool naming is passthrough by design: names are stable regardless of how many servers are
 * configured. A collision between two downstream servers is a startup error that points the
 * user to the explicit `prefix` option — never an automatic rename.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PREFIX_SEPARATOR, type SagazConfig, type ServerConfig } from "./config.js";
import { classify, type Classification } from "./classifier/index.js";
import { configHash, type EffectStatus, type Ledger } from "./ledger/index.js";
import { PREVIEW_INSTRUCTIONS, evaluatePolicy, gateResult, previewResult, type GateOutcome, type PolicyVerdict } from "./policy/index.js";
import { mapArgs, matchPack, matchPackEntry, payloadOf, type CompensationPack, type PackEntry, type PackMatch, type UndoNoPlan, type UndoToolCall } from "./undo/index.js";

export const PROXY_NAME = "sagaz";

/**
 * A capture read that takes longer than this proceeds without a pre-state (the effect runs, the
 * ledger records the no-plan). Deliberately short: the capture is Sagaz's read, not the
 * agent's — a hung capture must never hang the agent's call indefinitely.
 */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;

/** Outcome of the capture step, carried from before the forward to the plan derivation. */
type CaptureOutcome = { preState: CallToolResult } | { failure: string };

export class ToolCollisionError extends Error {
  override readonly name = "ToolCollisionError";
}

export class PackCollisionError extends Error {
  override readonly name = "PackCollisionError";
}

interface Route {
  server: string;
  /** Name as the downstream server knows it. */
  downstreamName: string;
  tool: Tool;
}

interface Downstream {
  name: string;
  config: ServerConfig;
  client: Client;
}

export interface ProxyOptions {
  version?: string;
  /** Where diagnostics go. Never stdout — that's the MCP channel. */
  log?: (line: string) => void;
  /** Injectable for tests: build a transport for a downstream server instead of spawning it. */
  connect?: (name: string, config: ServerConfig) => Transport;
  /** Effect ledger. Always on in the CLI; optional here so routing can be tested alone. */
  ledger?: Ledger;
  /** How often a `confirm` gate re-reads the approvals table while waiting (ms). */
  approvalPollMs?: number;
  /** Effect preview for the whole session (`sagaz serve --preview`). Also enabled by `preview: true` in the config. */
  preview?: boolean;
  /** Compensation packs. Defaults to the config's loaded `packs`; injectable for tests. */
  packs?: readonly CompensationPack[];
  /** How long a capture read may run before the effect proceeds without a pre-state (ms). */
  captureTimeoutMs?: number;
}

export function exposedName(server: ServerConfig, downstreamName: string): string {
  return server.prefix ? `${server.prefix}${PREFIX_SEPARATOR}${downstreamName}` : downstreamName;
}

/**
 * Pure: two packs covering the same downstream tool is a startup error, in the same spirit as
 * tool collisions — there is no defined order between packs, and picking an inverse by luck is
 * exactly the kind of magic Sagaz refuses to do. Within ONE pack, entry order is the author's
 * and first match wins.
 */
export function assertNoPackCollisions(packs: readonly CompensationPack[], toolsByServer: Map<string, Tool[]>): void {
  for (const [server, tools] of toolsByServer) {
    for (const tool of tools) {
      const matches = packs
        .map((pack) => ({ pack, entry: matchPackEntry(pack.entries, tool.name, server) }))
        .filter((m): m is PackMatch => m.entry !== undefined);
      if (matches.length > 1) {
        const who = matches.map((m) => `pack "${m.pack.name}" (entry "${m.entry.tool}")`).join(" and ");
        throw new PackCollisionError(
          `Compensation pack collision: tool "${tool.name}" on server "${server}" is covered by ${who}.\n` +
            `Sagaz never picks an inverse by magic. Narrow one of the entries (exact tool name instead of a glob, or a "server" restriction) or remove one of the packs.`,
        );
      }
    }
  }
}

/** Pure: builds the routing table or throws a ToolCollisionError with the suggested fix. */
export function buildRoutes(config: SagazConfig, toolsByServer: Map<string, Tool[]>): Map<string, Route> {
  const routes = new Map<string, Route>();
  for (const [server, tools] of toolsByServer) {
    const serverConfig = config.servers[server];
    if (!serverConfig) continue;
    for (const tool of tools) {
      const name = exposedName(serverConfig, tool.name);
      const existing = routes.get(name);
      if (existing) {
        throw new ToolCollisionError(
          `Tool name collision: "${name}" is exposed by both "${existing.server}" and "${server}".\n` +
            `Sagaz never renames tools automatically. Give one of them an explicit prefix in sagaz.config.json, e.g.\n` +
            `  "servers": { "${server}": { ..., "prefix": "${server}" } }  →  ${server}${PREFIX_SEPARATOR}${tool.name}`,
        );
      }
      routes.set(name, { server, downstreamName: tool.name, tool: { ...tool, name } });
    }
  }
  return routes;
}

function spawnTransport(config: ServerConfig): Transport {
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...config.env },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    stderr: "inherit",
  });
}

export class SagazProxy {
  private server: Server | undefined;
  private readonly version: string;
  private readonly downstreams: Downstream[] = [];
  private routes = new Map<string, Route>();
  private readonly log: (line: string) => void;
  private readonly connectTransport: (name: string, config: ServerConfig) => Transport;
  private readonly ledger: Ledger | undefined;
  private readonly approvalPollMs: number | undefined;
  private readonly preview: boolean;
  /** Packs in force. Empty when `"capture": false`: an inverse whose pre-state will never be captured is not a known inverse, so packs then neither capture nor classify. */
  private readonly packs: readonly CompensationPack[];
  private readonly captureTimeoutMs: number;
  private sessionId: string | undefined;

  constructor(
    private readonly config: SagazConfig,
    opts: ProxyOptions = {},
  ) {
    this.version = opts.version ?? "0.0.0";
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.connectTransport = opts.connect ?? ((_name, cfg) => spawnTransport(cfg));
    this.ledger = opts.ledger;
    this.approvalPollMs = opts.approvalPollMs;
    this.preview = Boolean(opts.preview || config.preview);
    this.packs = config.capture ? (opts.packs ?? config.packs) : [];
    this.captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  }

  /** True when the session runs dry (see the module comment). */
  get isPreview(): boolean {
    return this.preview;
  }

  /** Ledger session opened by the client's `initialize`, if any. */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Connects to every downstream server and builds the routing table. Throws on collision.
   * Callers must `close()` on failure too: downstream processes may already be running.
   */
  async start(): Promise<void> {
    for (const [name, config] of Object.entries(this.config.servers)) {
      const client = new Client({ name: PROXY_NAME, version: this.version });
      await client.connect(this.connectTransport(name, config));
      this.downstreams.push({ name, config, client });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshRoutes(`tools/list_changed from "${name}"`);
      });
    }
    this.routes = await this.collectRoutes();

    // `initialize` cannot be forwarded verbatim (N downstreams, one client); the one observable
    // piece is `instructions`, which we concatenate so the agent still sees them.
    const instructions = this.downstreams
      .map((d) => d.client.getInstructions())
      .filter((i): i is string => typeof i === "string" && i.length > 0);
    // In preview the agent is told up front, not only call by call: a plan made in the dark is worthless.
    if (this.preview) instructions.unshift(PREVIEW_INSTRUCTIONS);
    this.server = new Server(
      { name: PROXY_NAME, version: this.version },
      { capabilities: { tools: { listChanged: true } }, ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}) },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...this.routes.values()].map((r) => r.tool) }));
    this.server.setRequestHandler(CallToolRequestSchema, (req, extra) => this.callTool(req.params.name, req.params.arguments ?? {}, extra.signal));
    // One ledger session per client `initialize`, with the client's identity captured.
    this.server.oninitialized = () => this.openSession("initialize");
    this.log(`sagaz: proxying ${this.routes.size} tool(s) from ${this.downstreams.map((d) => d.name).join(", ")}${this.preview ? " — PREVIEW MODE: mutations are recorded, not executed" : ""}`);
  }

  /** Exposes the proxy to the client on the given transport. Requires a successful `start()`. */
  async serve(transport: Transport): Promise<void> {
    if (!this.server) throw new Error("SagazProxy.serve() called before start()");
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.downstreams.map((d) => d.client.close()));
    await this.server?.close();
  }

  /** Tool names currently exposed (for tests and `sagaz status` later). */
  get toolNames(): string[] {
    return [...this.routes.keys()];
  }

  private async collectRoutes(): Promise<Map<string, Route>> {
    const toolsByServer = new Map<string, Tool[]>();
    for (const d of this.downstreams) toolsByServer.set(d.name, await listAllTools(d.client));
    assertNoPackCollisions(this.packs, toolsByServer);
    return buildRoutes(this.config, toolsByServer);
  }

  private async refreshRoutes(reason: string): Promise<void> {
    try {
      this.routes = await this.collectRoutes();
      await this.server?.sendToolListChanged();
      this.log(`sagaz: tool list refreshed (${reason}), now ${this.routes.size} tool(s)`);
    } catch (err) {
      // Keep serving the previous table rather than dropping tools mid-session.
      this.log(`sagaz: tool list refresh failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private openSession(trigger: string): void {
    if (!this.ledger) return;
    const session = this.ledger.openSession({ clientInfo: this.server?.getClientVersion(), configHash: configHash(this.config) });
    this.sessionId = session.id;
    this.log(`sagaz: ledger session ${session.id} opened (${trigger})`);
  }

  /**
   * Ledger write policy: a failure to record never changes what the client sees. The call
   * already happened (or failed) downstream; we log loudly and return the real outcome.
   */
  private record(effectId: string | undefined, input: { status: Exclude<EffectStatus, "pending">; result: unknown }): void {
    if (effectId === undefined || !this.ledger) return;
    try {
      this.ledger.end(effectId, input);
    } catch (err) {
      this.log(`sagaz: LEDGER WRITE FAILED for effect ${effectId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const route = this.routes.get(name);
    if (!route) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const downstream = this.downstreams.find((d) => d.name === route.server);
    if (!downstream) throw new McpError(ErrorCode.InternalError, `No connection to server "${route.server}"`);

    // A compliant client sends notifications/initialized before any call; if one doesn't,
    // record anyway rather than silently skipping ("everything is recorded").
    if (this.ledger && !this.sessionId) this.openSession("first tools/call before initialized");

    // Order: classify → evaluate policy → begin() (the class is sealed into the row's hash when
    // the effect closes) → gate. A blocked or denied call closes as 'blocked' without ever being
    // forwarded; an allowed one follows the normal path.
    const classification = classify({
      tool: route.downstreamName,
      server: route.server,
      annotations: route.tool.annotations,
      rules: this.config.rules,
      packs: this.packs,
    });
    const verdict = evaluatePolicy({ tool: route.downstreamName, server: route.server, class: classification.class, policy: this.config.policy });
    const effectId =
      this.ledger && this.sessionId
        ? this.ledger.begin({ sessionId: this.sessionId, server: route.server, tool: route.downstreamName, args, classification })
        : undefined;

    // Preview: reads flow, everything else closes 'dry' here. The verdict is computed but never
    // applied — it is reported ("would have waited for approval") so the preview tells the whole story.
    if (this.preview && classification.class !== "read") {
      const ctx = { tool: route.downstreamName, server: route.server, class: classification.class, wouldHave: verdict.action };
      const result = previewResult(ctx, { preview: true, class: ctx.class, wouldHave: verdict.action, policy: verdict.reason });
      this.record(effectId, { status: "dry", result });
      this.log(`sagaz: dry ${route.downstreamName} (${ctx.class}; preview — would have: ${verdict.action})`);
      return result;
    }

    if (verdict.action !== "allow") {
      const stopped = await this.gate(route, effectId, classification, verdict, signal);
      if (stopped) return stopped;
    }

    // Capture hook (T10): only for calls that will actually be forwarded — after the gates
    // (a blocked call captures nothing) and before the forward (afterwards the pre-state no
    // longer exists). A capture failure is logged and later recorded as a no-plan, never
    // surfaced: Sagaz observes and protects, it does not break the agent's call.
    // (In preview only reads reach this point and nothing needs undoing, so the hook stays off;
    // without a ledger there is nowhere to store a pre-state or a plan, so nothing is read either.)
    const pack = this.ledger && !this.preview ? matchPack(this.packs, route.downstreamName, route.server)?.entry : undefined;
    const captured = pack?.capture ? await this.capture(pack.capture, downstream, effectId, args) : undefined;

    let result: CallToolResult;
    try {
      result = (await downstream.client.callTool({ name: route.downstreamName, arguments: args })) as CallToolResult;
    } catch (err) {
      // Protocol-level failure (transport, invalid params...): recorded, then re-thrown to the client.
      this.record(effectId, { status: "error", result: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
    this.record(effectId, { status: result.isError ? "error" : "ok", result });
    // Only a successful effect gets an undo plan: a failed or errored call changed nothing.
    if (pack && effectId !== undefined && !result.isError) this.planUndo(effectId, pack, route, args, result, captured);
    return result;
  }

  /**
   * Runs the pack's capture read and stores the pre-state on the pending effect (it is sealed
   * into the hash when the effect closes). Its own short timeout: a hung capture must not hang
   * the agent's call. Any failure — unresolvable args, transport error, tool error, timeout —
   * comes back as a `failure` for planUndo to record; the effect itself always proceeds.
   */
  private async capture(
    spec: NonNullable<PackEntry["capture"]>,
    downstream: Downstream,
    effectId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<CaptureOutcome> {
    try {
      const captureArgs = mapArgs(spec.args, { args });
      const preState = (await downstream.client.callTool(
        { name: spec.tool, arguments: captureArgs },
        undefined,
        { timeout: this.captureTimeoutMs },
      )) as CallToolResult;
      if (preState.isError) {
        const text = preState.content?.find((c) => c.type === "text")?.text;
        return { failure: `capture read ${spec.tool} returned an error${typeof text === "string" ? `: ${text}` : ""}` };
      }
      if (effectId !== undefined && this.ledger) {
        try {
          this.ledger.setPreState(effectId, preState);
        } catch (err) {
          // Same policy as record(): a ledger failure never changes what the agent sees.
          this.log(`sagaz: LEDGER WRITE FAILED storing pre-state for effect ${effectId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { preState };
    } catch (err) {
      const failure = `capture read ${spec.tool} failed: ${err instanceof Error ? err.message : String(err)}`;
      this.log(`sagaz: ${failure} — the call proceeds without a pre-state`);
      return { failure };
    }
  }

  /**
   * Closes the T10 loop after a successful effect with a pack entry: derives the inverse call
   * from args + result + pre-state and marks the plan (undo_status 'planned'). When no plan can
   * be made — the capture failed, or a mapping cannot be resolved — the effect keeps
   * undo_status 'none' and undo_json records the no-plan descriptor with the reason: the ledger
   * says "cannot be undone, and here is why" instead of silently having no opinion.
   */
  private planUndo(
    effectId: string,
    pack: PackEntry,
    route: Route,
    args: Record<string, unknown>,
    result: CallToolResult,
    captured: CaptureOutcome | undefined,
  ): void {
    const record = (undo: { undoStatus: "planned"; undoJson: UndoToolCall } | { undoStatus: "none"; undoJson: UndoNoPlan }) => {
      try {
        this.ledger?.setUndo(effectId, undo);
      } catch (err) {
        this.log(`sagaz: LEDGER WRITE FAILED storing undo plan for effect ${effectId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (captured && "failure" in captured) {
      this.log(`sagaz: no undo plan for ${route.downstreamName} — ${captured.failure}`);
      return record({ undoStatus: "none", undoJson: { kind: "no_plan", reason: captured.failure } });
    }
    try {
      const scope = { args, result: payloadOf(result), pre_state: captured ? payloadOf(captured.preState) : undefined };
      const undoArgs = mapArgs(pack.inverse.args, scope);
      const plan: UndoToolCall = { kind: "tool_call", server: route.server, tool: pack.inverse.tool, args: undoArgs };
      // A plan is stored whole or not at all: a truncated inverse is a corrupted inverse. The
      // pre-state row is capped by the same limit, so an oversized plan means the data to undo
      // this effect would not survive the ledger either.
      const bytes = Buffer.byteLength(JSON.stringify(plan), "utf8");
      if (bytes > this.config.ledger.maxResultBytes) {
        const reason = `derived plan for ${pack.inverse.tool} is ${bytes} bytes, over ledger.maxResultBytes (${this.config.ledger.maxResultBytes}) — refusing to store a truncated inverse`;
        this.log(`sagaz: no undo plan for ${route.downstreamName} — ${reason}`);
        return record({ undoStatus: "none", undoJson: { kind: "no_plan", reason } });
      }
      this.log(`sagaz: undo planned for ${route.downstreamName} → ${pack.inverse.tool}`);
      record({ undoStatus: "planned", undoJson: plan });
    } catch (err) {
      const reason = `cannot derive inverse ${pack.inverse.tool}: ${err instanceof Error ? err.message : String(err)}`;
      this.log(`sagaz: no undo plan for ${route.downstreamName} — ${reason}`);
      record({ undoStatus: "none", undoJson: { kind: "no_plan", reason } });
    }
  }

  /**
   * Applies a `block` or `confirm` verdict. Returns the reply for the agent when the call must
   * NOT be forwarded (recorded as 'blocked' first), or undefined when the operator allowed it.
   *
   * The reply carries the gate metadata in `_meta.sagaz`, so what the ledger stores as
   * result_json is exactly what the agent received — one source of truth for "why".
   */
  private async gate(
    route: Route,
    effectId: string | undefined,
    classification: Classification,
    verdict: PolicyVerdict,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult | undefined> {
    const base = { tool: route.downstreamName, server: route.server, class: classification.class, policy: verdict.reason };
    const stop = (outcome: GateOutcome, extra: { approvalId?: string; decidedBy?: string | null; waitedMs?: number } = {}) => {
      const result = gateResult({ ...base, outcome, decidedBy: extra.decidedBy, waitedMs: extra.waitedMs }, { gate: outcome, class: base.class, policy: base.policy, ...extra });
      this.record(effectId, { status: "blocked", result });
      this.log(`sagaz: ${outcome} ${route.downstreamName} (${base.class}; ${verdict.reason})`);
      return result;
    };

    if (verdict.action === "block") return stop("blocked");

    // confirm: the approvals table is the channel to the operator; without a ledger there is
    // no channel, and "confirm" must never degrade into "allow".
    if (!this.ledger || effectId === undefined) {
      this.log(`sagaz: confirm gate on ${route.downstreamName} but no ledger to coordinate an approval — treating as blocked`);
      return stop("blocked");
    }
    // Any failure of the approval channel itself is a stop, never a pass: the row must close
    // (everything is recorded) and "confirm" must not silently become "allow".
    let approvalId: string | undefined;
    const started = Date.now();
    try {
      approvalId = this.ledger.requestApproval(effectId).id;
      const timeoutMs = this.config.policy.confirmTimeoutMs;
      // The 8-char suffix is the operator's handle: what `sagaz pending`/`ledger` print and what `sagaz approve` resolves.
      this.log(`sagaz: holding ${route.downstreamName} for confirmation (${base.class}; ${verdict.reason}) — sagaz approve ${effectId.slice(-8)}`);
      const decided = await this.ledger.waitForDecision(approvalId, {
        timeoutMs,
        ...(this.approvalPollMs !== undefined ? { pollMs: this.approvalPollMs } : {}),
        ...(signal ? { signal } : {}),
      });
      if (decided.decision === "allow") {
        this.log(`sagaz: ${route.downstreamName} approved by ${decided.decided_by ?? "?"}`);
        return undefined;
      }
      if (decided.decided_by === "timeout") return stop("timeout", { approvalId, decidedBy: "timeout", waitedMs: Date.now() - started });
      if (decided.decided_by === "cancelled") return stop("cancelled", { approvalId, decidedBy: "cancelled", waitedMs: Date.now() - started });
      return stop("denied", { approvalId, decidedBy: decided.decided_by });
    } catch (err) {
      this.log(`sagaz: approval channel failed for ${route.downstreamName}: ${err instanceof Error ? err.message : String(err)} — treating as blocked`);
      return stop("blocked", { ...(approvalId !== undefined ? { approvalId } : {}) });
    }
  }
}

/**
 * Connects to every configured downstream, lists its tools and disconnects. What `sagaz packs`
 * uses to compute coverage without serving anything. Same transports as the proxy; `connect`
 * is injectable for tests exactly like ProxyOptions.connect.
 */
export async function probeDownstreamTools(
  config: SagazConfig,
  opts: { connect?: (name: string, config: ServerConfig) => Transport } = {},
): Promise<Map<string, Tool[]>> {
  const makeTransport = opts.connect ?? ((_name: string, cfg: ServerConfig) => spawnTransport(cfg));
  const toolsByServer = new Map<string, Tool[]>();
  const clients: Client[] = [];
  try {
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const client = new Client({ name: PROXY_NAME, version: "probe" });
      clients.push(client);
      await client.connect(makeTransport(name, serverConfig));
      toolsByServer.set(name, await listAllTools(client));
    }
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
  }
  return toolsByServer;
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}
