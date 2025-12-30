import { serveCommand, type ServeCommandOptions } from "./serve.js";
import { configCommand } from "./config.js";
import { tunnelCommand, type TunnelCommandOptions } from "./tunnel.js";
import { proxyCommand, type ProxyCommandOptions } from "./proxy.js";
import { connectCommand, type ConnectCommandOptions } from "./connect.js";
import { doctorCommand } from "./doctor.js";
import { oauthStatusCommand, oauthLoginCommand, oauthLogoutCommand } from "./oauth.js";
import type { TunnelProvider } from "../tunnel/index.js";
import type { OutputTransport } from "../proxy/types.js";

interface CliOptions extends ServeCommandOptions {
  tunnel?: TunnelProvider;
  port?: number;
  proxyStdio?: string;
  outputTransport?: OutputTransport;
  basePath?: string;
  ssePath?: string;
  messagePath?: string;
  streamableHttpPath?: string;
  stateful?: boolean;
  sessionTimeout?: number;
  healthEndpoint?: string;
  cors?: boolean;
  noCors?: boolean;
  maxRestarts?: number;
  project?: string;
  daemonMode?: boolean;
  socket?: string;
  oauthSubcommand?: OAuthSubcommand;
  clearCache?: boolean;
}

type Command = "serve" | "config" | "tunnel" | "proxy" | "connect" | "doctor" | "oauth" | "help";

interface OAuthSubcommand {
  action: "status" | "login" | "logout";
  serverName?: string;
  all?: boolean;
}

function parseArgs(args: string[]): {
  command: Command;
  options: CliOptions;
} {
  const options: CliOptions = {};
  let command: Command = "serve";

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

      case "proxy":
        command = "proxy";
        break;

      case "connect":
        command = "connect";
        break;

      case "doctor":
        command = "doctor";
        break;

      case "oauth": {
        command = "oauth";
        const subAction = args[++i];
        if (subAction === "status") {
          options.oauthSubcommand = { action: "status" };
        } else if (subAction === "login") {
          options.oauthSubcommand = { action: "login", serverName: args[++i] };
        } else if (subAction === "logout") {
          const nextArg = args[++i];
          if (nextArg === "--all") {
            options.oauthSubcommand = { action: "logout", all: true };
          } else {
            options.oauthSubcommand = { action: "logout", serverName: nextArg };
          }
        } else {
          console.error("Usage: routermcp oauth <status|login|logout>");
          process.exit(1);
        }
        break;
      }

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
        if (command === "proxy") {
          options.proxyStdio = args[++i];
        } else {
          options.stdio = true;
        }
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

      case "--outputTransport":
        const transport = args[++i];
        if (transport !== "sse" && transport !== "streamableHttp") {
          console.error("Error: --outputTransport must be 'sse' or 'streamableHttp'");
          process.exit(1);
        }
        options.outputTransport = transport;
        break;

      case "--basePath":
        options.basePath = args[++i];
        break;

      case "--ssePath":
        options.ssePath = args[++i];
        break;

      case "--messagePath":
        options.messagePath = args[++i];
        break;

      case "--streamableHttpPath":
        options.streamableHttpPath = args[++i];
        break;

      case "--stateful":
        options.stateful = true;
        break;

      case "--sessionTimeout":
        options.sessionTimeout = parseInt(args[++i], 10);
        if (isNaN(options.sessionTimeout)) {
          console.error("Error: --sessionTimeout requires a number (milliseconds)");
          process.exit(1);
        }
        break;

      case "--healthEndpoint":
        options.healthEndpoint = args[++i];
        break;

      case "--cors":
        options.cors = true;
        break;

      case "--no-cors":
        options.noCors = true;
        break;

      case "--maxRestarts":
        options.maxRestarts = parseInt(args[++i], 10);
        if (isNaN(options.maxRestarts)) {
          console.error("Error: --maxRestarts requires a number");
          process.exit(1);
        }
        break;

      case "--project":
        options.project = args[++i];
        break;

      case "--daemon-mode":
        options.daemonMode = true;
        break;

      case "--socket":
        options.socket = args[++i];
        break;

      case "--clear":
        options.clearCache = true;
        break;

      default:
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

function printHelp(): void {
  console.log(`
routermcp - MCP Gateway CLI

USAGE:
  routermcp [command] [options]

COMMANDS:
  serve     Start the MCP gateway (default)
  connect   Connect to gateway daemon (auto-starts if needed)
  proxy     Proxy a stdio MCP server over HTTP (SSE or Streamable HTTP)
  tunnel    Expose gateway via tunnel (Cloudflare, ngrok)
  config    Interactive configuration wizard
  doctor    Check configuration and authenticate OAuth servers
  oauth     Manage OAuth authentication
  help      Show this help message

SERVE OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --stdio               Use stdio transport (default)
  --http <port>         Use HTTP streamable transport on specified port
  --daemon-mode         Run as background daemon (for connect command)
  --socket <path>       Unix socket path (daemon mode, non-Windows)
  --clear               Clear OpenAPI cache before starting (force re-parse)
  -v, --verbose         Enable verbose logging

CONNECT OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --project <path>      Project directory (default: current directory)
  -v, --verbose         Enable verbose logging

PROXY OPTIONS:
  --stdio <command>           Command to spawn MCP server (required)
  --outputTransport <type>    Output transport: sse (default), streamableHttp
  -p, --port <port>           HTTP server port (default: 8000)
  --basePath <path>           Base path prefix for all endpoints (default: "")
  --ssePath <path>            SSE endpoint path (default: /sse)
  --messagePath <path>        Message endpoint path for SSE (default: /message)
  --streamableHttpPath <path> Streamable HTTP endpoint path (default: /mcp)
  --stateful                  Enable stateful sessions (streamableHttp only)
  --sessionTimeout <ms>       Session timeout in milliseconds (default: 60000)
  --healthEndpoint <path>     Health check endpoint (default: /health)
  --cors                      Enable CORS (default: true)
  --no-cors                   Disable CORS
  --maxRestarts <n>           Max child process restart attempts (default: 3)
  -v, --verbose               Enable verbose logging

TUNNEL OPTIONS:
  -c, --config <path>          Path to config file (default: ./routermcp.jsonc)
  --tunnel=<provider>          Tunnel provider: standalone (default), cloudflare, ngrok, routermcp-cloud
  -p, --port <port>            HTTP server port (default: 5151, or httpServer.port in config)
  -v, --verbose                Enable verbose logging

EXAMPLES:
  # Serve (gateway mode)
  routermcp                           Start gateway with default config (stdio mode)
  routermcp --http 3000               Start gateway with HTTP transport on port 3000

  # Connect (daemon mode - for multiple MCP clients)
  routermcp connect                   Connect to daemon (auto-starts if needed)
  routermcp connect --project /path   Connect using specific project directory

  # Proxy (single server mode)
  routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem ."
  routermcp proxy --stdio "node server.js" --outputTransport streamableHttp
  routermcp proxy --stdio "python mcp_server.py" --outputTransport streamableHttp --stateful
  routermcp proxy --stdio "npx mcp-server" --basePath /api/v1 --port 3000

  # Tunnel
  routermcp tunnel                       Start HTTP server only (interactive)
  routermcp tunnel --tunnel=cloudflare   Expose via Cloudflare tunnel
  routermcp tunnel --tunnel=ngrok        Expose via ngrok tunnel

  # Config
  routermcp config                    Run interactive configuration wizard

  # Doctor (OAuth setup)
  routermcp doctor                    Check config and authenticate OAuth servers

  # OAuth management
  routermcp oauth status              Show OAuth status for all servers
  routermcp oauth login <server>      Authenticate with a specific server
  routermcp oauth logout <server>     Clear tokens for a specific server
  routermcp oauth logout --all        Clear all OAuth tokens
`);
}

export async function main(args: string[]): Promise<void> {
  const { command, options } = parseArgs(args);

  switch (command) {
    case "serve":
      await serveCommand({
        config: options.config,
        stdio: options.stdio,
        http: options.http,
        verbose: options.verbose,
        daemonMode: options.daemonMode,
        socket: options.socket,
        clearCache: options.clearCache,
      });
      break;

    case "proxy":
      await proxyCommand({
        stdio: options.proxyStdio,
        outputTransport: options.outputTransport,
        port: options.port,
        basePath: options.basePath,
        ssePath: options.ssePath,
        messagePath: options.messagePath,
        streamableHttpPath: options.streamableHttpPath,
        stateful: options.stateful,
        sessionTimeout: options.sessionTimeout,
        healthEndpoint: options.healthEndpoint,
        cors: options.cors,
        noCors: options.noCors,
        verbose: options.verbose,
        maxRestarts: options.maxRestarts,
      });
      break;

    case "tunnel":
      await tunnelCommand({
        config: options.config,
        tunnel: options.tunnel,
        port: options.port,
        verbose: options.verbose,
      });
      break;

    case "connect":
      await connectCommand({
        config: options.config,
        project: options.project,
        verbose: options.verbose,
      });
      break;

    case "config":
      await configCommand();
      break;

    case "doctor":
      await doctorCommand(options.config || "./routermcp.jsonc");
      break;

    case "oauth": {
      const sub = options.oauthSubcommand;
      if (!sub) {
        console.error("Usage: routermcp oauth <status|login|logout>");
        process.exit(1);
      }
      const configPath = options.config || "./routermcp.jsonc";
      switch (sub.action) {
        case "status":
          await oauthStatusCommand(configPath);
          break;
        case "login":
          await oauthLoginCommand(configPath, sub.serverName || "");
          break;
        case "logout":
          await oauthLogoutCommand(sub.serverName || null, sub.all || false);
          break;
      }
      break;
    }

    case "help":
      printHelp();
      break;
  }
}
