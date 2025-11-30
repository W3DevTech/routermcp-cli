import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";

/**
 * Create a stdio client transport for connecting to an upstream MCP server.
 */
export async function createStdioClientTransport(
  serverName: string,
  config: ServerConfig
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  if (config.transport !== "stdio") {
    throw new TransportError(
      "stdio",
      `Expected stdio transport, got ${config.transport}`
    );
  }

  if (!config.command) {
    throw new TransportError("stdio", "Command is required for stdio transport");
  }

  // Build env object, filtering out undefined values
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (config.env) {
    Object.assign(env, config.env);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    cwd: config.cwd,
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
 * Create a stdio server transport for exposing the gateway.
 */
export function createStdioServerTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
