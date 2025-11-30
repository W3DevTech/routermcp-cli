import * as p from "@clack/prompts";
import { loadConfigFromPath } from "../config/loader.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import { ConfigError, RouterMcpError } from "../utils/errors.js";
import { configCommand } from "./config.js";

/**
 * Options for the serve command.
 */
export interface ServeCommandOptions {
  config?: string;
  stdio?: boolean;
  http?: number;
  verbose?: boolean;
}

/**
 * Run the serve command - starts the MCP gateway.
 */
export async function serveCommand(options: ServeCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;

  // Determine transport mode
  const mode: "stdio" | "http-streamable" = options.http
    ? "http-streamable"
    : "stdio";

  try {
    // Load configuration
    const { config, path } = await loadConfigFromPath(options.config);

    if (verbose) {
      console.error(`Loaded config from: ${path}`);
      console.error(
        `Configured servers: ${Object.keys(config.mcpServers).join(", ")}`
      );
    }

    // Create gateway
    const gateway = createGateway({
      config,
      mode,
      httpPort: options.http,
      verbose,
    });

    // Set up signal handlers for graceful shutdown
    setupSignalHandlers(gateway);

    // Start the gateway
    await gateway.start();

    // Keep process alive for stdio mode
    if (mode === "stdio") {
      // Process stays alive due to stdin being open
      await new Promise(() => {}); // Never resolves
    }
  } catch (err) {
    // Handle missing config file with interactive prompt
    if (
      err instanceof ConfigError &&
      err.message.includes("No config file found")
    ) {
      console.error(`Error: ${err.message}`);

      // Only offer interactive prompt if running in a TTY
      if (process.stdin.isTTY) {
        const shouldCreate = await p.confirm({
          message: "Would you like to create a config file now?",
        });

        if (!p.isCancel(shouldCreate) && shouldCreate) {
          await configCommand();

          // Show MCP client configuration instructions
          p.log.info("You can configure your MCP client as follows:");
          console.log(`
{
  "mcpServers": {
    "routermcp": {
      "command": "bunx",
      "args": [
        "-y",
        "routermcp"
      ]
    }
  }
}
`);
          return;
        }
      }

      process.exit(1);
    }

    if (err instanceof RouterMcpError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Set up signal handlers for graceful shutdown.
 */
function setupSignalHandlers(gateway: Gateway): void {
  const shutdown = async (signal: string) => {
    console.error(`\nReceived ${signal}, shutting down...`);
    try {
      await gateway.stop();
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
