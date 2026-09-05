import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "../config/types.js";
import type { RuntimeExecutionContext } from "../core/execution-context.js";
import { TransportError } from "../utils/errors.js";
import {
  createHttpClientTransport,
  createHttpServerTransport,
  type HttpClientTransportOptions,
  type HttpServerHandle,
  type HttpMcpRequestHandler,
  type HttpServerOptions,
} from "./http-streamable.js";
import {
  createEmbeddedServerTransport,
  type EmbeddedServerTransport,
} from "./embedded.js";
import { createStdioClientTransport, createStdioServerTransport } from "./stdio.js";

export {
  DAEMON_BRIDGE_LEASES_PATH,
  DAEMON_BRIDGE_LEASE_HEADER,
  DAEMON_HEALTH_PATH,
  DAEMON_HEALTH_PATH_LEGACY,
  DAEMON_WORKSPACE_HEADER,
  DEFAULT_DAEMON_CORS_ORIGIN,
  DEFAULT_DAEMON_CORS_ORIGINS,
  WORKSPACE_MCP_CREDENTIAL_PATH,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
  CONTROL_PLANE_BROWSER_CHALLENGE_PATH,
  CONTROL_PLANE_BROWSER_DEVICES_PATH,
  CONTROL_PLANE_BROWSER_EXCHANGE_PATH,
  type BridgeLeaseMetadata,
  type BridgeLeaseTracker,
  type HttpRequestContext,
  createHttpServerTransport,
  type HttpClientTransportOptions,
  type HttpServerHandle,
  type HttpMcpRequestHandler,
  type HttpServerOptions,
} from "./http-streamable.js";
export { createStdioServerTransport } from "./stdio.js";
export { createEmbeddedServerTransport, type EmbeddedServerTransport } from "./embedded.js";

export interface ClientConnection {
  client: Client;
  cleanup: () => Promise<void>;
}

export async function createClientTransport(
  serverName: string,
  config: ServerConfig,
  options?: HttpClientTransportOptions,
  executionContext?: RuntimeExecutionContext,
): Promise<ClientConnection> {
  switch (config.transport) {
    case "stdio":
      return createStdioClientTransport(serverName, config, executionContext);
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
  handleRequestWithSession?: (
    message: import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage,
    sessionId: string,
  ) => Promise<import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage | null>;
}

/**
 * Create a server transport for the gateway output.
 */
export function createServerTransport(
  mode: "stdio" | "http-streamable" | "embedded",
  httpPort?: number,
  httpHost?: string,
  httpOptions?: HttpServerOptions,
): ServerTransportHandle {
  if (mode === "embedded") {
    const transport: EmbeddedServerTransport = createEmbeddedServerTransport();
    return {
      transport,
      start: transport.start.bind(transport),
      stop: transport.close.bind(transport),
      getCurrentSessionId: () => transport.getCurrentSessionId(),
      handleRequestWithSession: transport.handleRequestWithSession.bind(transport),
    };
  }

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
