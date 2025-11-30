import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpServerConfig,
  ToolInfo,
  LocalTransportConfig,
  HttpStreamableTransportConfig,
} from "../types.ts";

export interface McpClientConnection {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Create a client connection to a local (stdio) MCP server
 */
async function connectLocal(
  name: string,
  config: LocalTransportConfig
): Promise<McpClientConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  });

  const client = new Client(
    { name: `routermcp-${name}`, version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Create a client connection to an HTTP streamable MCP server
 */
async function connectHttpStreamable(
  name: string,
  config: HttpStreamableTransportConfig
): Promise<McpClientConnection> {
  const url = new URL(config.url);
  const transport = new StreamableHTTPClientTransport(url);

  const client = new Client(
    { name: `routermcp-${name}`, version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Connect to an MCP server based on its configuration
 */
export async function connectToServer(
  name: string,
  config: McpServerConfig
): Promise<McpClientConnection> {
  switch (config.transport) {
    case "local":
      return connectLocal(name, config);
    case "http-streamable":
      return connectHttpStreamable(name, config);
    default:
      throw new Error(`Unsupported transport type: ${(config as McpServerConfig).transport}`);
  }
}

/**
 * Fetch tools from a connected MCP client
 */
export async function fetchTools(client: Client): Promise<ToolInfo[]> {
  const response = await client.listTools();
  return response.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
  }));
}

/**
 * Call a tool on a connected MCP client
 */
export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const response = await client.callTool({ name: toolName, arguments: args });
  return response;
}
