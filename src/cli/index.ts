import { serveCommand, type ServeCommandOptions } from "./serve.js";
import { configCommand } from "./config.js";

/**
 * Parse CLI arguments.
 */
function parseArgs(args: string[]): {
  command: "serve" | "config" | "help";
  options: ServeCommandOptions;
} {
  const options: ServeCommandOptions = {};
  let command: "serve" | "config" | "help" = "serve";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "config":
        command = "config";
        break;

      case "serve":
        command = "serve";
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

      default:
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
  config    Interactive configuration wizard
  help      Show this help message

OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --stdio               Use stdio transport (default)
  --http <port>         Use HTTP streamable transport on specified port
  -v, --verbose         Enable verbose logging
  -h, --help            Show help

EXAMPLES:
  routermcp                    Start gateway with default config
  routermcp --http 3000        Start gateway with HTTP transport on port 3000
  routermcp config             Run interactive configuration wizard
  routermcp -c ./custom.json   Use custom config file
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

    case "config":
      await configCommand();
      break;

    case "help":
      printHelp();
      break;
  }
}
