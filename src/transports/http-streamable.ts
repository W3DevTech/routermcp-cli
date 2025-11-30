import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";

/**
 * Create an HTTP streamable client transport for connecting to an upstream MCP server.
 */
export async function createHttpClientTransport(
  serverName: string,
  config: ServerConfig
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  if (config.transport !== "http-streamable") {
    throw new TransportError(
      "http-streamable",
      `Expected http-streamable transport, got ${config.transport}`
    );
  }

  if (!config.url) {
    throw new TransportError(
      "http-streamable",
      "URL is required for http-streamable transport"
    );
  }

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.headers,
    },
  });

  const client = new Client(
    {
      name: `routermcp-client-${serverName}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  const cleanup = async () => {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { client, cleanup };
}

/**
 * Server transport handle for HTTP.
 */
export interface HttpServerHandle {
  transport: Transport;
  server: ReturnType<typeof Bun.serve> | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Create an HTTP server transport for exposing the gateway using SSE.
 * Note: Uses SSEServerTransport which requires Node.js-style req/res.
 * For Bun, we create a simple JSON-RPC over HTTP endpoint.
 */
export function createHttpServerTransport(
  port: number,
  host: string = "127.0.0.1"
): HttpServerHandle {
  // For now, throw an error indicating HTTP server mode is not yet supported
  // The MCP SDK's HTTP transports are designed for Node.js HTTP server
  throw new TransportError(
    "http-streamable",
    "HTTP server transport is not yet supported in Bun. Please use stdio mode (--stdio) or run with Node.js compatibility layer."
  );
}
