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
import { UpstreamManager } from "./upstream.js";
import { Aggregator } from "./aggregator.js";

export type GatewayState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface GatewayOptions {
  config: RouterMcpConfig;
  mode: "stdio" | "http-streamable";
  httpPort?: number;
  httpHost?: string;
  verbose?: boolean;
}

export class Gateway {
  private state: GatewayState = "stopped";
  private server: Server;
  private upstreamManager: UpstreamManager;
  private aggregator: Aggregator;
  private serverTransport: ServerTransportHandle | null = null;
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;

    this.server = new Server(
      { name: "routermcp-gateway", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    this.upstreamManager = new UpstreamManager(options.config, options.verbose);
    this.aggregator = new Aggregator(this.upstreamManager);

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.aggregator.getTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.aggregator.callTool(name, args || {});
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return { resources: this.aggregator.getResources() };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return this.aggregator.readResource(uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return { prompts: this.aggregator.getPrompts() };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.aggregator.getPrompt(name, args);
    });
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
      await this.upstreamManager.discoverAll(concurrency);

      this.aggregator.refresh();

      const stats = this.aggregator.getStats();
      this.log(
        `Aggregated: ${stats.tools} tools, ${stats.resources} resources, ${stats.prompts} prompts`
      );

      const subprocessTimeout = this.options.config.subprocess_timeout ?? 180;
      const connectionTimeout = this.options.config.connection_timeout ?? 30;
      this.log(
        `Lazy loading: subprocess_timeout=${subprocessTimeout}s, connection_timeout=${connectionTimeout}s`
      );

      this.serverTransport = createServerTransport(
        this.options.mode,
        this.options.httpPort,
        this.options.httpHost
      );

      await this.server.connect(this.serverTransport.transport);
      await this.serverTransport.start();

      this.state = "running";
      this.log("Gateway running (lazy loading enabled, no active upstream connections)");

      if (this.options.mode === "stdio") {
        console.error("MCP Gateway ready (stdio mode, lazy loading enabled)");
      }
    } catch (err) {
      this.state = "error";
      throw err;
    }
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

    await this.upstreamManager.disconnectAll();

    this.state = "stopped";
    this.log("Gateway stopped");
  }

  getState(): GatewayState {
    return this.state;
  }

  getUpstreamManager(): UpstreamManager {
    return this.upstreamManager;
  }

  getAggregator(): Aggregator {
    return this.aggregator;
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
