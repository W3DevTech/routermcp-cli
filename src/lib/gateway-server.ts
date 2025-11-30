import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  RouterMcpConfig,
  McpServerConfig,
  AggregatedTool,
  ToolInfo,
} from "../types.ts";
import {
  connectToServer,
  fetchTools,
  type McpClientConnection,
} from "./mcp-client.ts";
import { filterTools } from "./tool-filter.ts";

interface ConnectedUpstream {
  name: string;
  config: McpServerConfig;
  connection: McpClientConnection;
  filteredTools: ToolInfo[];
}

/**
 * Gateway server that aggregates multiple MCP servers
 */
export class GatewayServer {
  private server: Server;
  private upstreams: Map<string, ConnectedUpstream> = new Map();
  private toolToServer: Map<string, string> = new Map();
  private aggregatedTools: AggregatedTool[] = [];

  constructor() {
    this.server = new Server(
      {
        name: "routermcp-gateway",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle list tools request
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.aggregatedTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        })),
      };
    });

    // Handle call tool request
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const serverName = this.toolToServer.get(name);
      if (!serverName) {
        throw new Error(`Tool not found: ${name}`);
      }

      const upstream = this.upstreams.get(serverName);
      if (!upstream) {
        throw new Error(`Server not connected: ${serverName}`);
      }

      const response = await upstream.connection.client.callTool({
        name,
        arguments: args,
      });

      return response;
    });
  }

  /**
   * Connect to all configured upstream MCP servers
   */
  async connectUpstreams(config: RouterMcpConfig): Promise<void> {
    const serverEntries = Object.entries(config.mcpServers);

    for (const [name, serverConfig] of serverEntries) {
      try {
        console.error(`Connecting to ${name}...`);
        const connection = await connectToServer(name, serverConfig);

        // Fetch and filter tools
        const allTools = await fetchTools(connection.client);
        const filteredTools = filterTools(allTools, serverConfig);

        this.upstreams.set(name, {
          name,
          config: serverConfig,
          connection,
          filteredTools,
        });

        // Add tools to aggregated list and mapping
        for (const tool of filteredTools) {
          this.aggregatedTools.push({
            ...tool,
            serverName: name,
          });
          this.toolToServer.set(tool.name, name);
        }

        console.error(
          `Connected to ${name}: ${filteredTools.length}/${allTools.length} tools available`
        );
      } catch (error) {
        console.error(`Failed to connect to ${name}:`, error);
      }
    }

    console.error(
      `Gateway ready with ${this.aggregatedTools.length} tools from ${this.upstreams.size} servers`
    );
  }

  /**
   * Start the gateway server with stdio transport
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Close all connections and stop the server
   */
  async close(): Promise<void> {
    for (const [name, upstream] of this.upstreams) {
      try {
        await upstream.connection.close();
        console.error(`Disconnected from ${name}`);
      } catch (error) {
        console.error(`Error disconnecting from ${name}:`, error);
      }
    }
    this.upstreams.clear();
    this.toolToServer.clear();
    this.aggregatedTools = [];
    await this.server.close();
  }

  /**
   * Get list of connected servers
   */
  getConnectedServers(): string[] {
    return Array.from(this.upstreams.keys());
  }

  /**
   * Get aggregated tools
   */
  getAggregatedTools(): AggregatedTool[] {
    return [...this.aggregatedTools];
  }
}
