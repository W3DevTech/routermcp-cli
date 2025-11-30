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

/**
 * Gateway state.
 */
export type GatewayState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

/**
 * Options for creating a gateway.
 */
export interface GatewayOptions {
  config: RouterMcpConfig;
  mode: "stdio" | "http-streamable";
  httpPort?: number;
  httpHost?: string;
  verbose?: boolean;
}

/**
 * MCP Gateway that aggregates multiple upstream servers.
 */
export class Gateway {
  private state: GatewayState = "stopped";
  private server: Server;
  private upstreamManager: UpstreamManager;
  private aggregator: Aggregator;
  private serverTransport: ServerTransportHandle | null = null;
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;

    // Initialize MCP server
    this.server = new Server(
      {
        name: "routermcp-gateway",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    // Initialize upstream manager and aggregator
    this.upstreamManager = new UpstreamManager(options.config, options.verbose);
    this.aggregator = new Aggregator(this.upstreamManager);

    // Register MCP handlers
    this.registerHandlers();
  }

  /**
   * Register MCP protocol handlers.
   */
  private registerHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.aggregator.getTools() };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.aggregator.callTool(name, args || {});
    });

    // List resources handler
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return { resources: this.aggregator.getResources() };
    });

    // Read resource handler
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return this.aggregator.readResource(uri);
    });

    // List prompts handler
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return { prompts: this.aggregator.getPrompts() };
    });

    // Get prompt handler
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.aggregator.getPrompt(name, args);
    });
  }

  /**
   * Start the gateway.
   */
  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(`Cannot start gateway in state: ${this.state}`);
    }

    this.state = "starting";
    this.log("Starting gateway...");

    try {
      // Connect to upstream servers
      await this.upstreamManager.connectAll();

      // Aggregate capabilities (applies filtering, checks collisions)
      this.aggregator.refresh();

      const stats = this.aggregator.getStats();
      this.log(
        `Aggregated: ${stats.tools} tools, ${stats.resources} resources, ${stats.prompts} prompts`
      );

      // Create and start server transport
      this.serverTransport = createServerTransport(
        this.options.mode,
        this.options.httpPort,
        this.options.httpHost
      );

      await this.server.connect(this.serverTransport.transport);
      await this.serverTransport.start();

      this.state = "running";
      this.log("Gateway is running");

      if (this.options.mode === "stdio") {
        console.error("MCP Gateway ready (stdio mode)");
      }
    } catch (err) {
      this.state = "error";
      throw err;
    }
  }

  /**
   * Stop the gateway.
   */
  async stop(): Promise<void> {
    if (this.state !== "running") {
      return;
    }

    this.state = "stopping";
    this.log("Stopping gateway...");

    // Stop server transport
    if (this.serverTransport) {
      await this.serverTransport.stop();
      this.serverTransport = null;
    }

    // Disconnect from upstreams
    await this.upstreamManager.disconnectAll();

    this.state = "stopped";
    this.log("Gateway stopped");
  }

  /**
   * Get current gateway state.
   */
  getState(): GatewayState {
    return this.state;
  }

  /**
   * Get upstream manager for status checks.
   */
  getUpstreamManager(): UpstreamManager {
    return this.upstreamManager;
  }

  /**
   * Get aggregator for capability info.
   */
  getAggregator(): Aggregator {
    return this.aggregator;
  }

  private log(message: string): void {
    if (this.options.verbose) {
      console.error(`[gateway] ${message}`);
    }
  }
}

/**
 * Create and return a new gateway instance.
 */
export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}
