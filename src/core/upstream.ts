/**
 * Upstream connection manager for MCP servers
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerConfig } from "../config/types.js";
import { createClient } from "../transports/index.js";
import { UpstreamConnectionError } from "../utils/errors.js";

export interface UpstreamServer {
  name: string;
  client: Client;
  config: ServerConfig;
}

export interface UpstreamConnectionResult {
  server: UpstreamServer;
  error?: Error;
}

/**
 * Connects to an upstream MCP server
 *
 * @param name Server name from config
 * @param config Server configuration
 * @returns UpstreamServer instance
 */
export async function connectUpstream(
  name: string,
  config: ServerConfig,
): Promise<UpstreamServer> {
  const client = await createClient({ serverName: name, config });

  return {
    name,
    client,
    config,
  };
}

/**
 * Connects to multiple upstream servers in parallel
 * Returns successfully connected servers and logs errors for failed connections
 *
 * @param servers Map of server names to configurations
 * @param onError Optional callback for connection errors
 * @returns Array of successfully connected upstream servers
 */
export async function connectAllUpstreams(
  servers: Record<string, ServerConfig>,
  onError?: (name: string, error: Error) => void,
): Promise<UpstreamServer[]> {
  const entries = Object.entries(servers);

  const results = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      try {
        return await connectUpstream(name, config);
      } catch (error) {
        const err =
          error instanceof Error
            ? new UpstreamConnectionError(name, error.message, error)
            : new UpstreamConnectionError(name, String(error));
        throw err;
      }
    }),
  );

  const upstreams: UpstreamServer[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const [name] = entries[i];

    if (result.status === "fulfilled") {
      upstreams.push(result.value);
    } else {
      const error =
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason));

      onError?.(name, error);
    }
  }

  return upstreams;
}

/**
 * Disconnects from all upstream servers
 */
export async function disconnectAllUpstreams(
  upstreams: UpstreamServer[],
): Promise<void> {
  await Promise.allSettled(
    upstreams.map(async (upstream) => {
      try {
        await upstream.client.close();
      } catch {
        // Ignore errors during disconnect
      }
    }),
  );
}
