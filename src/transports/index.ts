/**
 * Transport factory and exports
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerConfig } from "../config/types.js";
import { createStdioClient } from "./stdio.js";
import { createHttpStreamableClient } from "./http-streamable.js";
import { TransportError } from "../utils/errors.js";

export interface CreateClientOptions {
  serverName: string;
  config: ServerConfig;
}

/**
 * Creates a client for the given server configuration
 */
export async function createClient(options: CreateClientOptions): Promise<Client> {
  const { config } = options;

  switch (config.transport) {
    case "stdio":
      return createStdioClient(options);
    case "http-streamable":
      return createHttpStreamableClient(options);
    default:
      throw new TransportError(
        "unknown",
        `Unknown transport type: ${(config as ServerConfig).transport}`,
      );
  }
}

export { createStdioClient } from "./stdio.js";
export { createHttpStreamableClient } from "./http-streamable.js";

// Re-export MCP SDK transports for convenience
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
