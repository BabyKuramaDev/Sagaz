/**
 * The Sagaz interceptor: an MCP server towards the client, an MCP client towards each
 * downstream server. Transparent pass-through of tools/list and tools/call; every call is
 * classified (R/C/I, see classifier/), gated by policy (see policy/) and recorded in the
 * effect ledger — blocked attempts included.
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
import { configHash, type Ledger } from "./ledger/index.js";
import { evaluatePolicy, gateResult, type GateOutcome, type PolicyVerdict } from "./policy/index.js";

export const PROXY_NAME = "sagaz";

export class ToolCollisionError extends Error {
  override readonly name = "ToolCollisionError";
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
}

export function exposedName(server: ServerConfig, downstreamName: string): string {
  return server.prefix ? `${server.prefix}${PREFIX_SEPARATOR}${downstreamName}` : downstreamName;
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
    this.server = new Server(
      { name: PROXY_NAME, version: this.version },
      { capabilities: { tools: { listChanged: true } }, ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}) },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...this.routes.values()].map((r) => r.tool) }));
    this.server.setRequestHandler(CallToolRequestSchema, (req, extra) => this.callTool(req.params.name, req.params.arguments ?? {}, extra.signal));
    // One ledger session per client `initialize`, with the client's identity captured.
    this.server.oninitialized = () => this.openSession("initialize");
    this.log(`sagaz: proxying ${this.routes.size} tool(s) from ${this.downstreams.map((d) => d.name).join(", ")}`);
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
  private record(effectId: string | undefined, input: { status: "ok" | "error" | "blocked"; result: unknown }): void {
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
    });
    const verdict = evaluatePolicy({ tool: route.downstreamName, server: route.server, class: classification.class, policy: this.config.policy });
    const effectId =
      this.ledger && this.sessionId
        ? this.ledger.begin({ sessionId: this.sessionId, server: route.server, tool: route.downstreamName, args, classification })
        : undefined;

    if (verdict.action !== "allow") {
      const stopped = await this.gate(route, effectId, classification, verdict, signal);
      if (stopped) return stopped;
    }

    let result: CallToolResult;
    try {
      result = (await downstream.client.callTool({ name: route.downstreamName, arguments: args })) as CallToolResult;
    } catch (err) {
      // Protocol-level failure (transport, invalid params...): recorded, then re-thrown to the client.
      this.record(effectId, { status: "error", result: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
    this.record(effectId, { status: result.isError ? "error" : "ok", result });
    return result;
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
