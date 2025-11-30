import { serveCommand, type ServeCommandOptions } from "./serve.js";
import { configCommand } from "./config.js";
import { tunnelCommand, type TunnelCommandOptions } from "./tunnel.js";
import type { TunnelProvider } from "../tunnel/index.js";

/**
 * Combined CLI options.
 */
interface CliOptions extends ServeCommandOptions {
  tunnel?: TunnelProvider;
  port?: number;
}

/**
 * Parse CLI arguments.
 */
function parseArgs(args: string[]): {
  command: "serve" | "config" | "tunnel" | "help";
  options: CliOptions;
} {
  const options: CliOptions = {};
  let command: "serve" | "config" | "tunnel" | "help" = "serve";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "config":
        command = "config";
        break;

      case "serve":
        command = "serve";
        break;

      case "tunnel":
        command = "tunnel";
        break;

      case "help":
      case "--help":
      case "-h":
        command = "help";
        break;

      case "--config":
      case "-c":
        options.config = args[++i];
        break;

      case "--stdio":
        options.stdio = true;
        break;

      case "--http":
        options.http = parseInt(args[++i], 10);
        if (isNaN(options.http)) {
          console.error("Error: --http requires a port number");
          process.exit(1);
        }
        break;

      case "--verbose":
      case "-v":
        options.verbose = true;
        break;

      case "--port":
      case "-p":
        options.port = parseInt(args[++i], 10);
        if (isNaN(options.port)) {
          console.error("Error: --port requires a port number");
          process.exit(1);
        }
        break;

      default:
        // Handle --tunnel=<provider> format
        if (arg.startsWith("--tunnel=")) {
          const provider = arg.slice("--tunnel=".length) as TunnelProvider;
          if (!["standalone", "cloudflare", "ngrok", "routermcp-cloud"].includes(provider)) {
            console.error(`Unknown tunnel provider: ${provider}`);
            console.error("Available providers: standalone, cloudflare, ngrok, routermcp-cloud");
            process.exit(1);
          }
          options.tunnel = provider;
          break;
        }
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return { command, options };
}

/**
 * Print help message.
 */
function printHelp(): void {
  console.log(`
routermcp - MCP Gateway CLI

USAGE:
  routermcp [command] [options]

COMMANDS:
  serve     Start the MCP gateway (default)
  tunnel    Expose gateway via tunnel (Cloudflare, ngrok)
  config    Interactive configuration wizard
  help      Show this help message

SERVE OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --stdio               Use stdio transport (default)
  --http <port>         Use HTTP streamable transport on specified port
  -v, --verbose         Enable verbose logging

TUNNEL OPTIONS:
  -c, --config <path>          Path to config file (default: ./routermcp.jsonc)
  --tunnel=<provider>          Tunnel provider: standalone (default), cloudflare, ngrok, routermcp-cloud
  -p, --port <port>            HTTP server port (default: 5151, or httpServer.port in config)
  -v, --verbose                Enable verbose logging

EXAMPLES:
  routermcp                           Start gateway with default config (stdio mode)
  routermcp --http 3000               Start gateway with HTTP transport on port 3000
  routermcp tunnel                    Start HTTP server only (interactive)
  routermcp tunnel --tunnel=standalone   Start HTTP server without tunnel
  routermcp tunnel --tunnel=cloudflare   Expose via Cloudflare tunnel
  routermcp tunnel --tunnel=ngrok        Expose via ngrok tunnel
  routermcp tunnel --port 8080           Use custom port
  routermcp config                    Run interactive configuration wizard
`);
}

/**
 * Main CLI entry point.
 */
export async function main(args: string[]): Promise<void> {
  const { command, options } = parseArgs(args);

  switch (command) {
    case "serve":
      await serveCommand(options);
      break;

    case "tunnel":
      await tunnelCommand({
        config: options.config,
        tunnel: options.tunnel,
        port: options.port,
        verbose: options.verbose,
      });
      break;

    case "config":
      await configCommand();
      break;

    case "help":
      printHelp();
      break;
  }
}
