import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerConfig } from "../config/types.js";
import type { RuntimeExecutionContext } from "../core/execution-context.js";
import { TransportError } from "../utils/errors.js";

/**
 * Create a stdio client transport for connecting to an upstream MCP server.
 */
export async function createStdioClientTransport(
  serverName: string,
  config: ServerConfig,
  executionContext?: RuntimeExecutionContext,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  if (config.transport !== "stdio") {
    throw new TransportError("stdio", `Expected stdio transport, got ${config.transport}`);
  }

  if (!config.command) {
    throw new TransportError("stdio", "Command is required for stdio transport");
  }

  // Build env object, filtering out undefined values
  const env: Record<string, string> = {};
  const baseEnv = executionContext?.env ?? process.env;
  for (const [key, value] of Object.entries(baseEnv)) {
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
    cwd: resolveServerCwd(config.cwd, executionContext),
  });

  const client = new Client(
    {
      name: `routermcp-client-${serverName}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
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

function resolveServerCwd(
  configuredCwd: string | undefined,
  executionContext: RuntimeExecutionContext | undefined,
): string | undefined {
  if (!executionContext) return configuredCwd;
  if (!configuredCwd) return executionContext.cwd;
  return resolve(executionContext.cwd, configuredCwd);
}

/**
 * Create a stdio server transport for exposing the gateway.
 */
export function createStdioServerTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
