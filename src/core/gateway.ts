import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RouterMcpConfig } from "../config/types.js";
import { createServerTransport, type ServerTransportHandle } from "../transports/index.js";
import { UpstreamManager, type ServerCapabilityCache } from "./upstream.js";
import { Aggregator } from "./aggregator.js";
import {
  VirtualSessionManager,
  type CachedCapabilities,
  type VirtualSession,
} from "./virtual-session.js";

export type GatewayState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface GatewayOptions {
  config: RouterMcpConfig;
  mode: "stdio" | "http-streamable";
  httpPort?: number;
  httpHost?: string;
  verbose?: boolean;
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

  constructor(options: GatewayOptions) {
    this.options = options;

    this.server = new Server(
      { name: "routermcp-gateway", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    this.discoveryManager = new UpstreamManager(options.config, options.verbose);

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.cachedCapabilities) {
        return {
          tools: Array.from(this.cachedCapabilities.tools.values()).map((t) => t.tool),
        };
      }
      return { tools: [] };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const session = this.getSessionForRequest(extra);
      const { name, arguments: args } = request.params;
      return session.aggregator.callTool(name, args || {});
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (this.cachedCapabilities) {
        return {
          resources: Array.from(this.cachedCapabilities.resources.values()).map(
            (r) => r.resource
          ),
        };
      }
      return { resources: [] };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const session = this.getSessionForRequest(extra);
      const { uri } = request.params;
      return session.aggregator.readResource(uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
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

      this.cachedCapabilities = this.extractCapabilities();

      const stats = {
        tools: this.cachedCapabilities.tools.size,
        resources: this.cachedCapabilities.resources.size,
        prompts: this.cachedCapabilities.prompts.size,
      };
      this.log(`Aggregated: ${stats.tools} tools, ${stats.resources} resources, ${stats.prompts} prompts`);

      await this.discoveryManager.disconnectAll();

      const sessionConfig = this.options.config.session;
      const sessionTimeout = sessionConfig?.timeout ?? DEFAULT_SESSION_TIMEOUT;
      const maxSessions = sessionConfig?.max_sessions ?? DEFAULT_MAX_SESSIONS;

      this.sessionManager = new VirtualSessionManager({
        config: this.options.config,
        sessionTimeout,
        maxSessions,
        verbose: this.options.verbose,
        onSessionCleanup: (sessionId) => {
          if (sessionId === STDIO_SESSION_ID) {
            this.stdioSession = null;
          }
        },
      });

      this.sessionManager.setCapabilityCache(this.cachedCapabilities);

      this.log(`Session manager initialized (timeout: ${sessionTimeout}s, max: ${maxSessions})`);

      this.serverTransport = createServerTransport(
        this.options.mode,
        this.options.httpPort,
        this.options.httpHost
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

    return {
      tools: tempAggregator.getToolsMap(),
      resources: tempAggregator.getResourcesMap(),
      prompts: tempAggregator.getPromptsMap(),
      serverCapabilities,
    };
  }

  async stop(): Promise<void> {
    if (this.state !== "running") {
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

  private log(message: string): void {
    if (this.options.verbose) {
      console.error(`[gateway] ${message}`);
    }
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}
