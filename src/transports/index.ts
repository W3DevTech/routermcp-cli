import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";
import {
  createHttpClientTransport,
  createHttpServerTransport,
  type HttpClientTransportOptions,
  type HttpServerHandle,
  type HttpServerOptions,
} from "./http-streamable.js";
import { createStdioClientTransport, createStdioServerTransport } from "./stdio.js";

export {
  DAEMON_HEALTH_PATH,
  DAEMON_HEALTH_PATH_LEGACY,
  createHttpServerTransport,
  type HttpClientTransportOptions,
  type HttpServerHandle,
  type HttpServerOptions,
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
  getPort?: () => number | null;
}

/**
 * Create a server transport for the gateway output.
 */
export function createServerTransport(
  mode: "stdio" | "http-streamable",
  httpPort?: number,
  httpHost?: string,
  httpOptions?: HttpServerOptions,
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
    const handle = createHttpServerTransport(httpPort, httpHost, httpOptions);
    return {
      transport: handle.transport,
      start: handle.start,
      stop: handle.stop,
      getCurrentSessionId: () => handle.transport.getCurrentSessionId(),
      getPort: handle.getPort,
    };
  }

  throw new TransportError(mode, `Unknown server transport mode: ${mode}`);
}
