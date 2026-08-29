/**
 * The Sagaz interceptor: an MCP server towards the client, an MCP client towards each
 * downstream server. Phase 0 / T3: transparent pass-through of tools/list and tools/call.
 * No ledger yet.
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

  constructor(
    private readonly config: SagazConfig,
    opts: ProxyOptions = {},
  ) {
    this.version = opts.version ?? "0.0.0";
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.connectTransport = opts.connect ?? ((_name, cfg) => spawnTransport(cfg));
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
    this.server.setRequestHandler(CallToolRequestSchema, (req) => this.callTool(req.params.name, req.params.arguments ?? {}));
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

  private async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const route = this.routes.get(name);
    if (!route) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const downstream = this.downstreams.find((d) => d.name === route.server);
    if (!downstream) throw new McpError(ErrorCode.InternalError, `No connection to server "${route.server}"`);
    return (await downstream.client.callTool({ name: route.downstreamName, arguments: args })) as CallToolResult;
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
