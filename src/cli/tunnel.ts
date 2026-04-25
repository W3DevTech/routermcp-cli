import * as p from "@clack/prompts";
import { getScopeLabel, resolveConfigFromPath } from "../config/loader.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import { getTunnelProvider, type TunnelInfo, type TunnelProvider } from "../tunnel/index.js";
import { RouterMcpError } from "../utils/errors.js";

/**
 * Options for the tunnel command.
 */
export interface TunnelCommandOptions {
  config?: string;
  tunnel?: TunnelProvider;
  port?: number;
  verbose?: boolean;
}

const DEFAULT_PORT = 5151;

/**
 * Run the tunnel command.
 */
export async function tunnelCommand(options: TunnelCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;

  // If no tunnel provider specified, show interactive wizard
  const provider: TunnelProvider = options.tunnel ?? (await selectProvider());

  try {
    // Load configuration
    const { config, path, scope } = await resolveConfigFromPath(options.config);

    if (verbose) {
      console.error(`Loaded config from: ${path} [${getScopeLabel(scope)}]`);
    }

    // Determine port: CLI option > config > default
    const port = options.port ?? config.httpServer?.port ?? DEFAULT_PORT;

    // Create gateway in HTTP mode
    const gateway = createGateway({
      config,
      mode: "http-streamable",
      httpPort: port,
      httpHost: "127.0.0.1",
      verbose,
    });

    // Setup signal handlers for graceful shutdown
    let tunnelInfo: TunnelInfo | null = null;
    let tunnelProviderInstance: ReturnType<typeof getTunnelProvider> | null = null;

    if (provider !== "standalone") {
      tunnelProviderInstance = getTunnelProvider(provider);
    }

    setupSignalHandlers(gateway, async () => {
      if (tunnelInfo && tunnelProviderInstance) {
        console.error("\nStopping tunnel...");
        await tunnelProviderInstance.stop();
      }
    });

    // Start the gateway
    console.error("Starting MCP gateway...");
    await gateway.start();

    // Handle standalone mode (HTTP only, no tunnel)
    if (provider === "standalone") {
      const url = `http://127.0.0.1:${port}/mcp`;

      console.log();
      p.log.success("Gateway running!");
      console.log();
      console.log("=".repeat(60));
      console.log(`  MCP Gateway URL: ${url}`);
      console.log("=".repeat(60));
      console.log();
      console.log("Add this to your MCP client configuration:");
      console.log();
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              routermcp: {
                transport: "http-streamable",
                url,
              },
            },
          },
          null,
          2,
        ),
      );
      console.log();
      console.error("Use --tunnel=cloudflare or --tunnel=ngrok to expose publicly.");
      console.error("Press Ctrl+C to stop the server.");

      // Keep process alive
      await new Promise(() => {});
      return;
    }

    if (!tunnelProviderInstance) {
      throw new Error(`Tunnel provider not available: ${provider}`);
    }

    // Start the tunnel
    console.error(`Starting ${tunnelProviderInstance.displayName} tunnel...`);

    try {
      tunnelInfo = await tunnelProviderInstance.start(port);

      if (!tunnelInfo) {
        throw new Error("Tunnel provider did not return tunnel info");
      }

      // Display success message
      console.log();
      p.log.success("Tunnel established!");
      console.log();
      console.log("=".repeat(60));
      console.log(`  MCP Gateway URL: ${tunnelInfo.url}/mcp`);
      console.log("=".repeat(60));
      console.log();
      console.log("Add this to your MCP client configuration:");
      console.log();
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              routermcp: {
                transport: "http-streamable",
                url: `${tunnelInfo.url}/mcp`,
              },
            },
          },
          null,
          2,
        ),
      );
      console.log();
      console.error("Press Ctrl+C to stop the tunnel.");

      // Keep process alive
      await new Promise(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed to start tunnel: ${message}`);
      await gateway.stop();
      process.exit(1);
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
 * Interactive provider selection wizard.
 */
async function selectProvider(): Promise<TunnelProvider> {
  p.intro("RouterMCP Tunnel");

  const provider = await p.select({
    message: "Select a mode:",
    options: [
      {
        value: "standalone" as const,
        label: "Standalone (HTTP only)",
        hint: "Run local HTTP server without tunnel",
      },
      {
        value: "cloudflare" as const,
        label: "Cloudflare Tunnel",
        hint: "Recommended - Free, no signup required",
      },
      {
        value: "ngrok" as const,
        label: "ngrok",
        hint: "Requires free account",
      },
      {
        value: "routermcp-cloud" as const,
        label: "RouterMCP Cloud",
        hint: "Coming soon!",
      },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Tunnel setup cancelled");
    process.exit(0);
  }

  return provider;
}

/**
 * Setup signal handlers for graceful shutdown.
 */
function setupSignalHandlers(gateway: Gateway, additionalCleanup: () => Promise<void>): void {
  const shutdown = async (signal: string) => {
    console.error(`\nReceived ${signal}, shutting down...`);
    try {
      await additionalCleanup();
      await gateway.stop();
      console.error("Shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
