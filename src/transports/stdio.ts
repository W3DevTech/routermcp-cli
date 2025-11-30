/**
 * Stdio transport client for upstream MCP servers
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";

export interface StdioClientOptions {
  serverName: string;
  config: ServerConfig;
}

/**
 * Creates a stdio client transport for connecting to an upstream MCP server
 */
export async function createStdioClient(
  options: StdioClientOptions,
): Promise<Client> {
  const { serverName, config } = options;

  if (!config.command) {
    throw new TransportError(
      "stdio",
      `Command is required for stdio transport on server '${serverName}'`,
    );
  }

  // Build environment, filtering out undefined values
  let env: Record<string, string> | undefined;
  if (config.env) {
    env = {};
    for (const [key, value] of Object.entries({ ...process.env, ...config.env })) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "inherit",
  });

  const client = new Client(
    {
      name: "routermcp-gateway",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);
  } catch (error) {
    throw new TransportError(
      "stdio",
      `Failed to connect to upstream server '${serverName}'`,
      error instanceof Error ? error : undefined,
    );
  }

  return client;
}

export { StdioClientTransport };
