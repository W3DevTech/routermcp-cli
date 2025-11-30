/**
 * Main gateway serve command
 */

import * as p from "@clack/prompts";
import { Gateway } from "../core/gateway.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, GatewayError, CollisionError } from "../utils/errors.js";

export interface ServeOptions {
  config?: string;
  transport?: "stdio" | "http-streamable";
  port?: number;
}

/**
 * Start the MCP gateway server
 */
export async function serve(options: ServeOptions = {}): Promise<void> {
  const transport = options.transport ?? "stdio";

  if (transport !== "stdio") {
    p.log.error("Only stdio transport is currently supported");
    process.exit(1);
  }

  const gateway = new Gateway({
    configPath: options.config,
    onLog: (level, message) => {
      switch (level) {
        case "error":
          p.log.error(message);
          break;
        case "warn":
          p.log.warn(message);
          break;
        case "info":
          p.log.info(message);
          break;
        default:
          p.log.message(message);
      }
    },
  });

  try {
    await gateway.initialize({ configPath: options.config });
  } catch (error) {
    if (error instanceof ConfigError) {
      p.log.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof CollisionError) {
      p.log.error(`Name collision error: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof GatewayError) {
      p.log.error(`Gateway error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // Setup graceful shutdown
  const shutdown = async () => {
    await gateway.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect to stdio transport
  const stdioTransport = new StdioServerTransport();
  await gateway.connect(stdioTransport);
}
