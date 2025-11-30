import { findConfigFile, loadConfig } from "../lib/config-loader.ts";
import { GatewayServer } from "../lib/gateway-server.ts";

/**
 * Start the MCP gateway server
 */
export async function startCommand(): Promise<void> {
  // Find and load config
  const configPath = findConfigFile();
  if (!configPath) {
    console.error(
      "Error: No configuration file found. Please create routermcp.json or routermcp.jsonc"
    );
    console.error("Run 'routermcp config' to create a configuration interactively.");
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error(`Error loading configuration: ${error}`);
    process.exit(1);
  }

  const serverCount = Object.keys(config.mcpServers).length;
  if (serverCount === 0) {
    console.error("Error: No MCP servers configured.");
    console.error("Run 'routermcp config' to add servers.");
    process.exit(1);
  }

  console.error(`Loaded configuration from ${configPath}`);
  console.error(`Found ${serverCount} server(s) configured`);

  // Create and start gateway
  const gateway = new GatewayServer();

  // Handle shutdown signals
  const shutdown = async () => {
    console.error("\nShutting down gateway...");
    await gateway.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    // Connect to all upstream servers
    await gateway.connectUpstreams(config);

    // Start the gateway server
    await gateway.start();
  } catch (error) {
    console.error(`Error starting gateway: ${error}`);
    await gateway.close();
    process.exit(1);
  }
}
