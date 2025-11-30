import { loadConfigFromPath } from "../config/loader.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import { RouterMcpError } from "../utils/errors.js";

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
