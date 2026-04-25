import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";
import {
  createHttpClientTransport,
  createHttpServerTransport,
  type HttpClientTransportOptions,
  type HttpServerHandle,
} from "./http-streamable.js";
import { createStdioClientTransport, createStdioServerTransport } from "./stdio.js";

export {
  createHttpServerTransport,
  type HttpClientTransportOptions,
  type HttpServerHandle,
} from "./http-streamable.js";
export { createStdioServerTransport } from "./stdio.js";

export interface ClientConnection {
  client: Client;
  cleanup: () => Promise<void>;
}

export async function createClientTransport(
  serverName: string,
  config: ServerConfig,
  options?: HttpClientTransportOptions,
): Promise<ClientConnection> {
  switch (config.transport) {
    case "stdio":
      return createStdioClientTransport(serverName, config);
    case "http-streamable":
      return createHttpClientTransport(serverName, config, options);
    default:
      throw new TransportError(
        (config as ServerConfig).transport,
        `Unknown transport type: ${(config as ServerConfig).transport}`,
      );
  }
}

export interface ServerTransportHandle {
  transport: Transport;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getCurrentSessionId?: () => string | null;
}

/**
 * Create a server transport for the gateway output.
 */
export function createServerTransport(
  mode: "stdio" | "http-streamable",
  httpPort?: number,
  httpHost?: string,
): ServerTransportHandle {
  if (mode === "stdio") {
    const transport = createStdioServerTransport();
    return {
      transport,
      start: async () => {
        // Stdio transport starts automatically when connected
      },
      stop: async () => {
        // Stdio transport closes with the process
      },
    };
  }

  if (mode === "http-streamable") {
    if (!httpPort) {
      throw new TransportError("http-streamable", "Port is required for http-streamable transport");
    }
    const handle = createHttpServerTransport(httpPort, httpHost);
    return {
      transport: handle.transport,
      start: handle.start,
      stop: handle.stop,
      getCurrentSessionId: () => handle.transport.getCurrentSessionId(),
    };
  }

  throw new TransportError(mode, `Unknown server transport mode: ${mode}`);
}
