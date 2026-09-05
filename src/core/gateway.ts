import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RouterMcpConfig } from "../config/types.js";
import { ConnectionTracker, type ConnectionLease } from "../daemon/connection-tracker.js";
import { OpenApiHandler } from "../openapi/index.js";
import type { OpenApiServerSnapshot } from "../openapi/index.js";
import {
  createServerTransport,
  type BridgeLeaseTracker,
  type HttpRequestContext,
  type HttpServerOptions,
  type ServerTransportHandle,
} from "../transports/index.js";
import { Aggregator } from "./aggregator.js";
import { getCodeModeMetaTools, handleExecuteCode, handleListTools } from "./codemode/index.js";
import type { RuntimeExecutionContext } from "./execution-context.js";
import {
  getToolSearchMetaTools,
  handleCallTool,
  handleSearchMcpForTask,
} from "./toolsearch/index.js";
import {
  type ServerCapabilityCache,
  type UpstreamServer,
  UpstreamManager,
} from "./upstream.js";
import {
  type CachedCapabilities,
  type VirtualSession,
  VirtualSessionManager,
  type VirtualSessionSnapshot,
} from "./virtual-session.js";

export type GatewayState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface GatewayOptions {
  config: RouterMcpConfig;
  mode: "stdio" | "http-streamable";
  httpPort?: number;
  httpHost?: string;
  httpOptions?: HttpServerOptions;
  verbose?: boolean;
  clearOpenApiCache?: boolean;
  /** Workspace-owned cwd/environment used by upstream clients. */
  executionContext?: RuntimeExecutionContext;
}

const DEFAULT_SESSION_TIMEOUT = 300;
const DEFAULT_MAX_SESSIONS = 25;
const STDIO_SESSION_ID = "__stdio__";

export class Gateway {
  private state: GatewayState = "stopped";
  private server: Server;
  private discoveryManager: UpstreamManager;
  private sessionManager: VirtualSessionManager | null = null;
  private cachedCapabilities: CachedCapabilities | null = null;
  private serverTransport: ServerTransportHandle | null = null;
  private options: GatewayOptions;
  private stdioSession: VirtualSession | null = null;
  private openApiHandler: OpenApiHandler | null = null;
  private readonly connectionTracker: BridgeLeaseTracker | null;
  private readonly ownedConnectionTracker: ConnectionTracker | null;

  constructor(options: GatewayOptions) {
    this.options = options;

    if (options.mode === "http-streamable") {
      const configuredTracker = options.httpOptions?.connectionTracker;
      if (configuredTracker) {
        this.connectionTracker = configuredTracker;
        this.ownedConnectionTracker = null;
      } else {
        const tracker = new ConnectionTracker();
        this.connectionTracker = tracker;
        this.ownedConnectionTracker = tracker;
      }
    } else {
      this.connectionTracker = null;
      this.ownedConnectionTracker = null;
    }

    this.server = new Server(
      { name: "routermcp-gateway", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    this.discoveryManager = new UpstreamManager(
      options.config,
      options.verbose,
      undefined,
      options.executionContext,
    );

    this.registerHandlers();
  }

  private isCodeModeEnabled(): boolean {
    return this.options.config.codeMode?.enabled === true;
  }

  private isToolSearchEnabled(): boolean {
    return this.options.config.mcpToolSearch?.enabled === true;
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      this.getSessionForRequest(extra);
      if (this.isCodeModeEnabled()) {
        return { tools: getCodeModeMetaTools() };
      }
      if (this.isToolSearchEnabled()) {
        const metaTools = getToolSearchMetaTools(this.options.config.mcpToolSearch);
        return { tools: metaTools };
      }
      if (this.cachedCapabilities) {
        return {
          tools: Array.from(this.cachedCapabilities.tools.values()).map((t) => t.tool),
        };
      }
      return { tools: [] };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;

      if (this.isCodeModeEnabled() && name.startsWith("routermcp.")) {
        return this.handleMetaTool(name, args || {}, extra);
      }

      if (this.isToolSearchEnabled() && name.startsWith("routermcp.")) {
        const session = this.getSessionForRequest(extra);
        return this.handleToolSearchMetaTool(name, args || {}, session.aggregator);
      }

      if (this.openApiHandler?.hasTool(name)) {
        return this.openApiHandler.callTool(name, args || {});
      }

      const session = this.getSessionForRequest(extra);
      return session.aggregator.callTool(name, args || {});
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
      this.getSessionForRequest(extra);
      if (this.cachedCapabilities) {
        return {
          resources: Array.from(this.cachedCapabilities.resources.values()).map((r) => r.resource),
        };
      }
      return { resources: [] };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const session = this.getSessionForRequest(extra);
      const { uri } = request.params;
      return session.aggregator.readResource(uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async (_request, extra) => {
      this.getSessionForRequest(extra);
      if (this.cachedCapabilities) {
        return {
          prompts: Array.from(this.cachedCapabilities.prompts.values()).map((p) => p.prompt),
        };
      }
      return { prompts: [] };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const session = this.getSessionForRequest(extra);
      const { name, arguments: args } = request.params;
      return session.aggregator.getPrompt(name, args);
    });
  }

  private getSessionForRequest(extra: unknown): VirtualSession {
    if (this.options.mode === "stdio") {
      if (!this.stdioSession && this.sessionManager) {
        this.stdioSession = this.sessionManager.getOrCreate(STDIO_SESSION_ID);
      }
      if (!this.stdioSession) {
        throw new Error("Session manager not initialized");
      }
      return this.stdioSession;
    }

    const sessionId = this.extractSessionId(extra);
    if (!this.sessionManager) {
      throw new Error("Session manager not initialized");
    }
    return this.sessionManager.getOrCreate(sessionId);
  }

  private extractSessionId(extra: unknown): string {
    if (
      extra &&
      typeof extra === "object" &&
      "sessionId" in extra &&
      typeof (extra as { sessionId: unknown }).sessionId === "string"
    ) {
      return (extra as { sessionId: string }).sessionId;
    }

    const transportSessionId = this.serverTransport?.getCurrentSessionId?.();
    if (transportSessionId) {
      return transportSessionId;
    }

    return crypto.randomUUID();
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(`Cannot start gateway in state: ${this.state}`);
    }

    this.state = "starting";
    this.log("Starting gateway...");

    try {
      const concurrency = this.options.config.discovery_concurrency ?? 5;
      this.log(`Discovering upstream capabilities (concurrency: ${concurrency})...`);
      await this.discoveryManager.discoverAll(concurrency);

      if (this.options.config.openApiServers) {
        this.openApiHandler = new OpenApiHandler(
          this.options.config.openApiServers,
          this.options.verbose,
          this.options.executionContext?.cwd,
        );
        await this.openApiHandler.initialize(this.options.clearOpenApiCache);

        const openApiStats = this.openApiHandler.getStats();
        this.log(
          `OpenAPI: ${openApiStats.readyServers}/${openApiStats.totalServers} servers, ${openApiStats.totalTools} tools`,
        );
      }

      this.cachedCapabilities = this.extractCapabilities();

      const stats = {
        tools: this.cachedCapabilities.tools.size,
        resources: this.cachedCapabilities.resources.size,
        prompts: this.cachedCapabilities.prompts.size,
      };
      this.log(
        `Aggregated: ${stats.tools} tools, ${stats.resources} resources, ${stats.prompts} prompts`,
      );

      await this.discoveryManager.disconnectAll();

      const sessionConfig = this.options.config.session;
      const sessionTimeout = sessionConfig?.timeout ?? DEFAULT_SESSION_TIMEOUT;
      const maxSessions = sessionConfig?.max_sessions ?? DEFAULT_MAX_SESSIONS;

      this.sessionManager = new VirtualSessionManager({
        config: this.options.config,
        sessionTimeout,
        maxSessions,
        verbose: this.options.verbose,
        executionContext: this.options.executionContext,
        onSessionCleanup: (sessionId) => {
          if (sessionId === STDIO_SESSION_ID) {
            this.stdioSession = null;
          }
        },
      });

      this.sessionManager.setCapabilityCache(this.cachedCapabilities);

      this.log(`Session manager initialized (timeout: ${sessionTimeout}s, max: ${maxSessions})`);

      if (this.isCodeModeEnabled()) {
        this.log("Code Mode enabled - exposing meta-tools instead of raw tools");
      }

      if (this.isToolSearchEnabled()) {
        const config = this.options.config.mcpToolSearch;
        this.log(
          `Tool Search enabled - exposing routermcp.searchMcpForTask + routermcp.callTool ` +
            `(maxResults: ${config?.maxResults ?? 5}, minScore: ${config?.minScore ?? 0})`,
        );
      }

      const httpOptions: HttpServerOptions | undefined =
        this.options.mode === "http-streamable" && this.connectionTracker
          ? {
              ...this.options.httpOptions,
              connectionTracker: this.connectionTracker,
              onSessionInitialize: async (sessionId, clientInfo, context) => {
                this.sessionManager?.getOrCreate(sessionId, clientInfo);
                await this.options.httpOptions?.onSessionInitialize?.(sessionId, clientInfo, context);
              },
              onSessionClose: async (sessionId, context) => {
                await this.sessionManager?.cleanup(sessionId);
                await this.options.httpOptions?.onSessionClose?.(sessionId, context);
              },
            }
          : this.options.httpOptions;

      this.serverTransport = createServerTransport(
        this.options.mode,
        this.options.httpPort,
        this.options.httpHost,
        httpOptions,
      );

      await this.server.connect(this.serverTransport.transport);
      await this.serverTransport.start();

      this.state = "running";
      this.log("Gateway running");

      if (this.options.mode === "stdio") {
        console.error("MCP Gateway ready (stdio mode)");
      }
    } catch (err) {
      this.state = "error";
      throw err;
    }
  }

  private extractCapabilities(): CachedCapabilities {
    const tempAggregator = new Aggregator(this.discoveryManager);
    tempAggregator.refresh();

    const serverCapabilities = new Map<string, ServerCapabilityCache>();
    for (const server of this.discoveryManager.getDiscoveredOrConnected()) {
      serverCapabilities.set(server.name, {
        tools: server.cachedTools,
        resources: server.cachedResources,
        prompts: server.cachedPrompts,
      });
    }

    const toolsMap = tempAggregator.getToolsMap();

    if (this.openApiHandler) {
      for (const [name, entry] of this.openApiHandler.getToolsMap()) {
        if (toolsMap.has(name)) {
          console.error(
            `[gateway] Warning: OpenAPI tool "${name}" collides with MCP tool, skipping`,
          );
          continue;
        }
        toolsMap.set(name, entry);
      }
    }

    return {
      tools: toolsMap,
      resources: tempAggregator.getResourcesMap(),
      prompts: tempAggregator.getPromptsMap(),
      serverCapabilities,
    };
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }

    this.state = "stopping";
    this.log("Stopping gateway...");

    if (this.serverTransport) {
      await this.serverTransport.stop();
      this.serverTransport = null;
    }

    if (this.sessionManager) {
      await this.sessionManager.cleanupAll();
      this.sessionManager = null;
    }

    // Startup can fail before the transport or session manager is created.
    // Always release any upstream clients opened during discovery as part of
    // teardown so a failed daemon cannot keep subprocesses or sockets alive.
    await this.discoveryManager.disconnectAll();

    this.ownedConnectionTracker?.destroy();

    this.stdioSession = null;

    this.state = "stopped";
    this.log("Gateway stopped");
  }

  getState(): GatewayState {
    return this.state;
  }

  getSessionStats(): { activeSessions: number; maxSessions: number } | null {
    return this.sessionManager?.getStats() ?? null;
  }

  /**
   * Return the currently configured upstreams without exposing mutable
   * gateway internals to management-plane adapters. Discovery state is merged
   * with active per-session managers so on-demand failures are visible.
   */
  getUpstreamServers(): readonly UpstreamServer[] {
    const merged = new Map<string, UpstreamServer>();
    for (const server of this.discoveryManager.getAll()) {
      merged.set(server.name, server);
    }

    const sessionServers = this.sessionManager?.getUpstreamServers() ?? [];
    for (const server of sessionServers) {
      const current = merged.get(server.name);
      if (!current) {
        merged.set(server.name, server);
        continue;
      }

      merged.set(server.name, mergeUpstreamServerHealth(current, server));
    }

    // A successful connection in one virtual session must clear a stale
    // startup discovery error, but an error in another still-active session
    // is meaningful because session upstream connections are isolated. Keep
    // that aggregate state degraded until the failing session reconnects or
    // expires.
    for (const failure of latestSessionFailures(sessionServers)) {
      const current = merged.get(failure.name);
      if (!current) continue;

      merged.set(failure.name, {
        ...current,
        status: "error",
        error: failure.error ?? current.error,
      });
    }

    return Array.from(merged.values());
  }

  /** Return browser-safe OpenAPI adapter state for the local management API. */
  getOpenApiServerSnapshots(): readonly OpenApiServerSnapshot[] {
    return this.openApiHandler?.getSnapshots() ?? [];
  }

  /** Return browser-safe session timing data for the local management API. */
  getSessionSnapshots(): readonly VirtualSessionSnapshot[] {
    return this.sessionManager?.getSnapshots() ?? [];
  }

  /** Return active bridge leases when the HTTP gateway owns a tracker. */
  getConnectionLeases(): readonly ConnectionLease[] {
    const tracker = this.connectionTracker;
    return tracker?.leases?.map((lease) => ({ ...lease })) ?? [];
  }

  getHttpPort(): number | null {
    return this.serverTransport?.getPort?.() ?? this.options.httpPort ?? null;
  }

  private log(message: string): void {
    if (this.options.verbose) {
      console.error(`[gateway] ${message}`);
    }
  }

  private async handleMetaTool(
    name: string,
    args: Record<string, unknown>,
    extra: unknown,
  ): Promise<CallToolResult> {
    if (!this.cachedCapabilities) {
      return {
        content: [{ type: "text", text: "Gateway not initialized" }],
        isError: true,
      };
    }

    const codeMode = this.options.config.codeMode ?? { enabled: false };

    switch (name) {
      case "routermcp.listTools":
        return handleListTools(args, this.cachedCapabilities.tools);

      case "routermcp.executeCode": {
        const session = this.getSessionForRequest(extra);
        return handleExecuteCode(args, session.aggregator, this.cachedCapabilities.tools, codeMode);
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown meta-tool: ${name}` }],
          isError: true,
        };
    }
  }

  private async handleToolSearchMetaTool(
    name: string,
    args: Record<string, unknown>,
    aggregator: Aggregator,
  ): Promise<CallToolResult> {
    if (!this.cachedCapabilities) {
      return {
        content: [{ type: "text", text: "Gateway not initialized" }],
        isError: true,
      };
    }

    const config = this.options.config.mcpToolSearch ?? { enabled: false };

    switch (name) {
      case "routermcp.searchMcpForTask":
        return handleSearchMcpForTask(args, this.cachedCapabilities.tools, config);

      case "routermcp.callTool":
        return handleCallTool(args, aggregator, this.cachedCapabilities.tools);

      default:
        return {
          content: [{ type: "text", text: `Unknown tool search meta-tool: ${name}` }],
          isError: true,
        };
    }
  }
}

export function mergeUpstreamServerHealth(
  base: UpstreamServer,
  candidate: UpstreamServer,
): UpstreamServer {
  const latestStatus = latestUpstreamRecord(base, candidate);
  const latest = latestUpstreamObservation(base, candidate);
  return {
    ...base,
    // Discovery and per-session managers are independent observations. An
    // error from startup must not permanently dominate a later successful
    // on-demand connection, and a newer on-demand failure must not be hidden
    // by an older cached discovery result.
    status: latestStatus.status,
    error: latestStatus.status === "error" ? latestStatus.error : null,
    client: candidate.client ?? base.client,
    cleanup: candidate.cleanup ?? base.cleanup,
    tools: candidate.tools.length > base.tools.length ? candidate.tools : base.tools,
    resources:
      candidate.resources.length > base.resources.length ? candidate.resources : base.resources,
    prompts: candidate.prompts.length > base.prompts.length ? candidate.prompts : base.prompts,
    cachedTools:
      candidate.cachedTools.length > base.cachedTools.length ? candidate.cachedTools : base.cachedTools,
    cachedResources:
      candidate.cachedResources.length > base.cachedResources.length
        ? candidate.cachedResources
        : base.cachedResources,
    cachedPrompts:
      candidate.cachedPrompts.length > base.cachedPrompts.length
        ? candidate.cachedPrompts
        : base.cachedPrompts,
    lastActivity: Math.max(base.lastActivity ?? 0, candidate.lastActivity ?? 0) || null,
    lastCheckedAt: latest.lastCheckedAt,
    lastLatencyMs: latest.lastLatencyMs,
    idleTimer: candidate.idleTimer ?? base.idleTimer,
    connectionPromise: candidate.connectionPromise ?? base.connectionPromise,
  };
}

function latestUpstreamRecord(base: UpstreamServer, candidate: UpstreamServer): UpstreamServer {
  const baseCheckedAt = base.lastCheckedAt ?? -1;
  const candidateCheckedAt = candidate.lastCheckedAt ?? -1;
  return candidateCheckedAt >= baseCheckedAt ? candidate : base;
}

function latestSessionFailures(servers: readonly UpstreamServer[]): UpstreamServer[] {
  const failures = new Map<string, UpstreamServer>();
  for (const server of servers) {
    if (server.status !== "error") continue;

    const current = failures.get(server.name);
    if (!current || (server.lastCheckedAt ?? -1) >= (current.lastCheckedAt ?? -1)) {
      failures.set(server.name, server);
    }
  }
  return Array.from(failures.values());
}

function latestUpstreamObservation(
  base: UpstreamServer,
  candidate: UpstreamServer,
): Pick<UpstreamServer, "lastCheckedAt" | "lastLatencyMs"> {
  const baseCheckedAt = base.lastCheckedAt ?? -1;
  const candidateCheckedAt = candidate.lastCheckedAt ?? -1;
  return candidateCheckedAt >= baseCheckedAt
    ? { lastCheckedAt: candidate.lastCheckedAt, lastLatencyMs: candidate.lastLatencyMs }
    : { lastCheckedAt: base.lastCheckedAt, lastLatencyMs: base.lastLatencyMs };
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}
