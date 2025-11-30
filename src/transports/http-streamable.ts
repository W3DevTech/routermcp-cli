/**
 * HTTP streamable transport client for upstream MCP servers
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";

export interface HttpStreamableClientOptions {
  serverName: string;
  config: ServerConfig;
}

/**
 * Creates an HTTP streamable client transport for connecting to an upstream MCP server
 */
export async function createHttpStreamableClient(
  options: HttpStreamableClientOptions,
): Promise<Client> {
  const { serverName, config } = options;

  if (!config.url) {
    throw new TransportError(
      "http-streamable",
      `URL is required for http-streamable transport on server '${serverName}'`,
    );
  }

  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new TransportError(
      "http-streamable",
      `Invalid URL '${config.url}' for server '${serverName}'`,
    );
  }

  const requestInit: RequestInit = {};
  if (config.headers) {
    requestInit.headers = config.headers;
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit,
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
      "http-streamable",
      `Failed to connect to upstream server '${serverName}'`,
      error instanceof Error ? error : undefined,
    );
  }

  return client;
}

export { StreamableHTTPClientTransport };
