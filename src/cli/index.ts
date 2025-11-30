/**
 * CLI command router
 */

import * as p from "@clack/prompts";
import { serve, type ServeOptions } from "./serve.js";
import { configWizard } from "./config.js";

export interface CliArgs {
  command?: string;
  config?: string;
  transport?: string;
  port?: number;
  help?: boolean;
  version?: boolean;
}

const HELP_TEXT = `
RouterMCP CLI - MCP Gateway that aggregates multiple upstream servers

USAGE:
  routermcp [command] [options]

COMMANDS:
  serve     Start the MCP gateway server (default)
  config    Run interactive configuration wizard

OPTIONS:
  -c, --config <path>      Path to configuration file
  -t, --transport <type>   Transport type (stdio, http-streamable)
  -p, --port <number>      Port for HTTP transport
  -h, --help               Show this help message
  -v, --version            Show version

EXAMPLES:
  routermcp serve
  routermcp serve -c my-config.jsonc
  routermcp config
`;

const VERSION = "0.1.0";

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg === "-v" || arg === "--version") {
      result.version = true;
    } else if (arg === "-c" || arg === "--config") {
      result.config = args[++i];
    } else if (arg === "-t" || arg === "--transport") {
      result.transport = args[++i];
    } else if (arg === "-p" || arg === "--port") {
      result.port = parseInt(args[++i], 10);
    } else if (!arg.startsWith("-") && !result.command) {
      result.command = arg;
    }

    i++;
  }

  return result;
}

/**
 * Run the CLI
 */
export async function run(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsedArgs = parseArgs(args);

  if (parsedArgs.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (parsedArgs.version) {
    console.log(`routermcp v${VERSION}`);
    return;
  }

  const command = parsedArgs.command ?? "serve";

  switch (command) {
    case "serve": {
      const options: ServeOptions = {
        config: parsedArgs.config,
        transport:
          parsedArgs.transport === "http-streamable"
            ? "http-streamable"
            : "stdio",
        port: parsedArgs.port,
      };
      await serve(options);
      break;
    }

    case "config":
      await configWizard();
      break;

    default:
      p.log.error(`Unknown command: ${command}`);
      console.log(HELP_TEXT);
      process.exit(1);
  }
}

export { serve, configWizard };
