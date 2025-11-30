/**
 * Main gateway orchestrator
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RouterMcpConfig } from "../config/types.js";
import { loadConfig } from "../config/loader.js";
import {
  connectAllUpstreams,
  disconnectAllUpstreams,
  type UpstreamServer,
} from "./upstream.js";
import {
  aggregateCapabilities,
  type AggregatedCapabilities,
} from "./aggregator.js";
import { GatewayError } from "../utils/errors.js";

export interface GatewayOptions {
  configPath?: string;
  config?: RouterMcpConfig;
  onLog?: (level: string, message: string) => void;
}

/**
 * MCP Gateway that aggregates multiple upstream servers
 */
export class Gateway {
  private server: Server;
  private upstreams: UpstreamServer[] = [];
  private capabilities: AggregatedCapabilities | null = null;
  private config: RouterMcpConfig | null = null;
  private onLog: (level: string, message: string) => void;

  constructor(options: GatewayOptions = {}) {
    this.onLog = options.onLog ?? (() => {});

    this.server = new Server(
      {
        name: "routermcp-gateway",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    this.setupHandlers();
  }

  /**
   * Initialize the gateway with configuration
   */
  async initialize(options: GatewayOptions = {}): Promise<void> {
    // Load configuration
    if (options.config) {
      this.config = options.config;
    } else {
      this.config = await loadConfig(options.configPath);
    }

    this.log("info", `Loaded configuration with ${Object.keys(this.config.mcpServers).length} server(s)`);

    // Connect to all upstream servers
    this.upstreams = await connectAllUpstreams(
      this.config.mcpServers,
      (name, error) => {
        this.log("warn", `Failed to connect to upstream '${name}': ${error.message}`);
      },
    );

    if (this.upstreams.length === 0) {
      throw new GatewayError("No upstream servers connected successfully");
    }

    this.log(
      "info",
      `Connected to ${this.upstreams.length} upstream server(s): ${this.upstreams.map((u) => u.name).join(", ")}`,
    );

    // Aggregate capabilities
    this.capabilities = await aggregateCapabilities(this.upstreams);

    this.log("info", `Aggregated ${this.capabilities.tools.size} tool(s)`);
    this.log("info", `Aggregated ${this.capabilities.resources.size} resource(s)`);
    this.log("info", `Aggregated ${this.capabilities.prompts.size} prompt(s)`);
  }

  /**
   * Connect the gateway to a transport
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Shutdown the gateway
   */
  async shutdown(): Promise<void> {
    await this.server.close();
    await disconnectAllUpstreams(this.upstreams);
    this.log("info", "Gateway shutdown complete");
  }

  private log(level: string, message: string): void {
    this.onLog(level, message);
  }

  private setupHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.capabilities) {
        return { tools: [] };
      }

      const tools = Array.from(this.capabilities.tools.values()).map(
        (agg) => agg.tool,
      );
      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!this.capabilities) {
        throw new Error("Gateway not initialized");
      }

      const aggregatedTool = this.capabilities.tools.get(name);
      if (!aggregatedTool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      // Find the upstream server
      const upstream = this.upstreams.find(
        (u) => u.name === aggregatedTool.source,
      );
      if (!upstream) {
        throw new Error(`Upstream server '${aggregatedTool.source}' not connected`);
      }

      // Forward the request
      const result = await upstream.client.callTool({ name, arguments: args });
      return result;
    });

    // List resources handler
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (!this.capabilities) {
        return { resources: [] };
      }

      const resources = Array.from(this.capabilities.resources.values()).map(
        (agg) => agg.resource,
      );
      return { resources };
    });

    // Read resource handler
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (!this.capabilities) {
        throw new Error("Gateway not initialized");
      }

      const aggregatedResource = this.capabilities.resources.get(uri);
      if (!aggregatedResource) {
        throw new Error(`Unknown resource: ${uri}`);
      }

      // Find the upstream server
      const upstream = this.upstreams.find(
        (u) => u.name === aggregatedResource.source,
      );
      if (!upstream) {
        throw new Error(
          `Upstream server '${aggregatedResource.source}' not connected`,
        );
      }

      // Forward the request
      const result = await upstream.client.readResource({ uri });
      return result;
    });

    // List prompts handler
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      if (!this.capabilities) {
        return { prompts: [] };
      }

      const prompts = Array.from(this.capabilities.prompts.values()).map(
        (agg) => agg.prompt,
      );
      return { prompts };
    });

    // Get prompt handler
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!this.capabilities) {
        throw new Error("Gateway not initialized");
      }

      const aggregatedPrompt = this.capabilities.prompts.get(name);
      if (!aggregatedPrompt) {
        throw new Error(`Unknown prompt: ${name}`);
      }

      // Find the upstream server
      const upstream = this.upstreams.find(
        (u) => u.name === aggregatedPrompt.source,
      );
      if (!upstream) {
        throw new Error(
          `Upstream server '${aggregatedPrompt.source}' not connected`,
        );
      }

      // Forward the request
      const result = await upstream.client.getPrompt({ name, arguments: args });
      return result;
    });
  }

  /**
   * Get the underlying MCP server
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Get connected upstreams
   */
  getUpstreams(): UpstreamServer[] {
    return this.upstreams;
  }

  /**
   * Get aggregated capabilities
   */
  getCapabilities(): AggregatedCapabilities | null {
    return this.capabilities;
  }
}
