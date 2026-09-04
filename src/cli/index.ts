import type { ConfigScope } from "../config/types.js";
import type { OutputTransport } from "../proxy/types.js";
import type { TunnelProvider } from "../tunnel/index.js";
import { VERSION } from "../version.js";
import {
  configAddCommand,
  configCommand,
  configListCommand,
  configRemoveCommand,
} from "./config.js";
import { type ConnectCommandOptions, connectCommand } from "./connect.js";
import {
  type DaemonCommandOptions,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./daemon.js";
import { doctorCommand } from "./doctor.js";
import { oauthLoginCommand, oauthLogoutCommand, oauthStatusCommand } from "./oauth.js";
import { type ProxyCommandOptions, proxyCommand } from "./proxy.js";
import { type ServeCommandOptions, serveCommand } from "./serve.js";
import { type TelemetryAction, telemetryCommand } from "./telemetry.js";
import { type ToolsCommandOptions, toolsCommand } from "./tools.js";
import { type TunnelCommandOptions, tunnelCommand } from "./tunnel.js";

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
  telemetryAction?: TelemetryAction;
  configSubcommand?: ConfigSubcommand;
  toolsJson?: boolean;
  json?: boolean;
}

type Command =
  | "serve"
  | "config"
  | "tunnel"
  | "proxy"
  | "connect"
  | "start"
  | "status"
  | "stop"
  | "restart"
  | "doctor"
  | "oauth"
  | "telemetry"
  | "tools"
  | "help"
  | "version";

interface OAuthSubcommand {
  action: "status" | "login" | "logout";
  serverName?: string;
  all?: boolean;
}

export interface ConfigAddOptions {
  serverName: string;
  command?: string;
  args?: string[];
  url?: string;
  scope: ConfigScope;
  env: Record<string, string>;
  headers: Record<string, string>;
  allowTools?: string[];
  denyTools?: string[];
  force: boolean;
}

export interface ConfigRemoveOptions {
  serverName: string;
  scope?: ConfigScope;
}

export interface ConfigListOptions {
  scope?: ConfigScope;
  json: boolean;
}

type ConfigSubcommand =
  | { action: "wizard" }
  | { action: "add"; options: ConfigAddOptions }
  | { action: "remove"; options: ConfigRemoveOptions }
  | { action: "list"; options: ConfigListOptions };

export function parseArgs(args: string[]): {
  command: Command;
  options: CliOptions;
} {
  const options: CliOptions = {};
  // A bare invocation is an MCP client launch and should reuse the managed
  // daemon. Foreground ownership remains available through an explicit
  // `serve` command (or the explicit HTTP/daemon flags below).
  let command: Command = "connect";
  let explicitCommand = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "config": {
        explicitCommand = true;
        command = "config";
        // Check for subcommands: add, remove, list
        const nextArg = args[i + 1];
        if (nextArg === "add") {
          i++; // consume "add"
          const serverName = args[++i];
          if (!serverName || serverName.startsWith("-")) {
            console.error(
              "Usage: routermcp config add <server-name> --command <cmd> | --url <url>",
            );
            process.exit(1);
          }
          const addOptions: ConfigAddOptions = {
            serverName,
            scope: "user-global",
            env: {},
            headers: {},
            force: false,
          };
          // Parse remaining args for config add
          while (i + 1 < args.length) {
            const opt = args[i + 1];
            if (opt === "--command") {
              i++;
              addOptions.command = args[++i];
            } else if (opt === "--args") {
              i++;
              addOptions.args = args[++i]?.split(",").map((a) => a.trim());
            } else if (opt === "--url") {
              i++;
              addOptions.url = args[++i];
            } else if (opt === "--scope") {
              i++;
              const scope = args[++i];
              if (
                scope !== "user-global" &&
                scope !== "project-local" &&
                scope !== "user-project"
              ) {
                console.error("Error: --scope must be user-global, project-local, or user-project");
                process.exit(1);
              }
              addOptions.scope = scope;
            } else if (opt === "--env") {
              i++;
              const envPair = args[++i];
              const eqIdx = envPair?.indexOf("=");
              if (eqIdx && eqIdx > 0) {
                addOptions.env[envPair.slice(0, eqIdx)] = envPair.slice(eqIdx + 1);
              }
            } else if (opt === "--headers") {
              i++;
              const headerPair = args[++i];
              const eqIdx = headerPair?.indexOf("=");
              if (eqIdx && eqIdx > 0) {
                addOptions.headers[headerPair.slice(0, eqIdx)] = headerPair.slice(eqIdx + 1);
              }
            } else if (opt === "--allow-tools") {
              i++;
              addOptions.allowTools = args[++i]?.split(",").map((t) => t.trim());
            } else if (opt === "--deny-tools") {
              i++;
              addOptions.denyTools = args[++i]?.split(",").map((t) => t.trim());
            } else if (opt === "--force") {
              i++;
              addOptions.force = true;
            } else {
              break; // Unknown option, stop parsing config add args
            }
          }
          options.configSubcommand = { action: "add", options: addOptions };
        } else if (nextArg === "remove") {
          i++; // consume "remove"
          const serverName = args[++i];
          if (!serverName || serverName.startsWith("-")) {
            console.error("Usage: routermcp config remove <server-name> [--scope <scope>]");
            process.exit(1);
          }
          const removeOptions: ConfigRemoveOptions = { serverName };
          // Parse optional --scope
          if (args[i + 1] === "--scope") {
            i++;
            const scope = args[++i];
            if (scope !== "user-global" && scope !== "project-local" && scope !== "user-project") {
              console.error("Error: --scope must be user-global, project-local, or user-project");
              process.exit(1);
            }
            removeOptions.scope = scope;
          }
          options.configSubcommand = { action: "remove", options: removeOptions };
        } else if (nextArg === "list") {
          i++; // consume "list"
          const listOptions: ConfigListOptions = { json: false };
          // Parse optional args
          while (i + 1 < args.length) {
            const opt = args[i + 1];
            if (opt === "--scope") {
              i++;
              const scope = args[++i];
              if (
                scope !== "user-global" &&
                scope !== "project-local" &&
                scope !== "user-project"
              ) {
                console.error("Error: --scope must be user-global, project-local, or user-project");
                process.exit(1);
              }
              listOptions.scope = scope;
            } else if (opt === "--json") {
              i++;
              listOptions.json = true;
            } else {
              break;
            }
          }
          options.configSubcommand = { action: "list", options: listOptions };
        } else {
          // No subcommand - will run wizard
          options.configSubcommand = { action: "wizard" };
        }
        break;
      }

      case "serve":
        explicitCommand = true;
        command = "serve";
        break;

      case "tunnel":
        explicitCommand = true;
        command = "tunnel";
        break;

      case "proxy":
        explicitCommand = true;
        command = "proxy";
        break;

      case "connect":
        explicitCommand = true;
        command = "connect";
        break;

      case "start":
        explicitCommand = true;
        command = "start";
        break;

      case "status":
        explicitCommand = true;
        command = "status";
        break;

      case "stop":
        explicitCommand = true;
        command = "stop";
        break;

      case "restart":
        explicitCommand = true;
        command = "restart";
        break;

      case "doctor":
        explicitCommand = true;
        command = "doctor";
        break;

      case "tools": {
        explicitCommand = true;
        command = "tools";
        while (i + 1 < args.length) {
          const opt = args[i + 1];
          if (opt === "--json") {
            i++;
            options.toolsJson = true;
          } else {
            break;
          }
        }
        break;
      }

      case "oauth": {
        explicitCommand = true;
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

      case "telemetry": {
        explicitCommand = true;
        command = "telemetry";
        const telemetryAction = args[++i];
        if (
          telemetryAction === "enable" ||
          telemetryAction === "disable" ||
          telemetryAction === "status"
        ) {
          options.telemetryAction = telemetryAction;
        } else if (telemetryAction && !telemetryAction.startsWith("-")) {
          console.error(`Unknown telemetry action: ${telemetryAction}`);
          console.error("Usage: routermcp telemetry <enable|disable|status>");
          process.exit(1);
        }
        break;
      }

      case "help":
      case "--help":
      case "-h":
        explicitCommand = true;
        command = "help";
        break;

      case "version":
      case "--version":
        explicitCommand = true;
        command = "version";
        break;

      case "-v":
        options.verbose = true;
        break;

      case "--json":
        if (command === "tools") {
          options.toolsJson = true;
        } else {
          options.json = true;
        }
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
          if (!explicitCommand) command = "serve";
        }
        break;

      case "--http":
        options.http = Number.parseInt(args[++i], 10);
        if (!explicitCommand) command = "serve";
        if (Number.isNaN(options.http)) {
          console.error("Error: --http requires a port number");
          process.exit(1);
        }
        break;

      case "--host":
        options.host = args[++i];
        if (!explicitCommand) command = "serve";
        if (!options.host) {
          console.error("Error: --host requires a host name");
          process.exit(1);
        }
        break;

      case "--verbose":
        options.verbose = true;
        break;

      case "--port":
      case "-p":
        options.port = Number.parseInt(args[++i], 10);
        if (Number.isNaN(options.port)) {
          console.error("Error: --port requires a port number");
          process.exit(1);
        }
        break;

      case "--outputTransport": {
        const transport = args[++i];
        if (transport !== "sse" && transport !== "streamableHttp") {
          console.error("Error: --outputTransport must be 'sse' or 'streamableHttp'");
          process.exit(1);
        }
        options.outputTransport = transport;
        break;
      }

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
        options.sessionTimeout = Number.parseInt(args[++i], 10);
        if (Number.isNaN(options.sessionTimeout)) {
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
        options.maxRestarts = Number.parseInt(args[++i], 10);
        if (Number.isNaN(options.maxRestarts)) {
          console.error("Error: --maxRestarts requires a number");
          process.exit(1);
        }
        break;

      case "--project":
        options.project = args[++i];
        break;

      case "--daemon-mode":
        options.daemonMode = true;
        if (!explicitCommand) command = "serve";
        break;

      case "--socket":
        options.socket = args[++i];
        if (!explicitCommand) command = "serve";
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
  routermcp -v, --version    Print version and exit

COMMANDS:
  serve     Start the MCP gateway in the foreground
  connect   Connect to gateway daemon (auto-starts if needed)
  start     Start or reuse the profile daemon
  status    Show daemon status
  stop      Stop the profile daemon
  restart   Restart the profile daemon
  proxy     Proxy a stdio MCP server over HTTP (SSE or Streamable HTTP)
  tunnel    Expose gateway via tunnel (Cloudflare, ngrok)
  config    Configuration management (wizard, add, remove, list)
  doctor    Check configuration and authenticate OAuth servers
  oauth     Manage OAuth authentication
  telemetry Manage anonymous error reporting
  tools     List all tools from configured MCP servers
  help      Show this help message

SERVE OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --stdio               Use stdio transport (default)
  --http <port>         Use HTTP streamable transport on specified port
  --host <host>         HTTP bind host (managed daemon must use loopback)
  --daemon-mode         Run as background daemon (for connect command)
  --clear               Clear OpenAPI cache before starting (force re-parse)
  --verbose             Enable verbose logging

  CONNECT OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --project <path>      Project directory (default: current directory)
  --verbose             Enable verbose logging

DAEMON OPTIONS:
  -c, --config <path>   Path to config file
  --project <path>      Project directory (default: current directory)
  --host <host>         HTTP bind host (managed daemon must use loopback)
  --port <port>         Preferred daemon port (falls back when occupied)
  --json                Print machine-readable status
  --verbose             Enable verbose logging

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
  --verbose               Enable verbose logging

TUNNEL OPTIONS:
  -c, --config <path>          Path to config file (default: ./routermcp.jsonc)
  --tunnel=<provider>          Tunnel provider: standalone (default), cloudflare, ngrok, routermcp-cloud
  -p, --port <port>            HTTP server port (default: 5151, or httpServer.port in config)
  --verbose                Enable verbose logging

CONFIG SUBCOMMANDS:
  config                Run interactive configuration wizard
  config add            Add a server (non-interactive)
  config remove         Remove a server
  config list           List configured servers

CONFIG ADD OPTIONS:
  <server-name>              Server name (required)
  --command <cmd>            Stdio command (auto-splits args on whitespace)
  --args <args>              Explicit comma-separated args (overrides auto-split)
  --url <url>                HTTP URL (mutually exclusive with --command)
  --scope <scope>            Config scope: user-global (default), project-local, user-project
  --env <key=value>          Environment variable (repeatable)
  --headers <key=value>      HTTP header (repeatable)
  --allow-tools <patterns>   Comma-separated tool allow patterns
  --deny-tools <patterns>    Comma-separated tool deny patterns
  --force                    Overwrite if server already exists

CONFIG REMOVE OPTIONS:
  <server-name>              Server name (required)
  --scope <scope>            Config scope (searches all scopes if not specified)

CONFIG LIST OPTIONS:
  --scope <scope>            Show only this scope (shows all if not specified)
  --json                     Output as JSON

TOOLS OPTIONS:
  -c, --config <path>   Path to config file (default: ./routermcp.jsonc)
  --json                     Output as JSON array
  --verbose                  Enable verbose logging

EXAMPLES:
  # Serve (gateway mode)
  routermcp                           Connect via the reusable daemon (auto-starts if needed)
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

  # Config (wizard)
  routermcp config                    Run interactive configuration wizard

  # Config add (one-liner)
  routermcp config add my-server --command "npx -y @modelcontextprotocol/server-filesystem ."
  routermcp config add my-api --url "http://localhost:3000/mcp"
  routermcp config add my-server --command "npx server" --scope project-local
  routermcp config add my-server --command "npx server" --env "API_KEY=\${env:MY_KEY}"

  # Config remove
  routermcp config remove my-server
  routermcp config remove my-server --scope user-global

  # Config list
  routermcp config list
  routermcp config list --scope user-global
  routermcp config list --json

  # Doctor (OAuth setup)
  routermcp doctor                    Check config and authenticate OAuth servers

  # OAuth management
  routermcp oauth status              Show OAuth status for all servers
  routermcp oauth login <server>      Authenticate with a specific server
  routermcp oauth logout <server>     Clear tokens for a specific server
  routermcp oauth logout --all        Clear all OAuth tokens

  # Telemetry
  routermcp telemetry                 Show telemetry status
  routermcp telemetry enable          Enable anonymous error reporting (default)
  routermcp telemetry disable         Disable anonymous error reporting

  # Tools
  routermcp tools                    List all tools (human-readable)
  routermcp tools --json              List all tools as JSON
`);
}

let currentCommand: Command = "serve";
let currentArgs: string[] = [];

export function getCurrentCommand(): string {
  return currentCommand;
}

export function getCurrentArgs(): string[] {
  return currentArgs;
}

export async function main(args: string[]): Promise<void> {
  currentArgs = args;
  const { command, options } = parseArgs(args);
  currentCommand = command;

  switch (command) {
    case "serve":
      await serveCommand({
        config: options.config,
        stdio: options.stdio,
        http: options.http,
        host: options.host,
        verbose: options.verbose,
        daemonMode: options.daemonMode,
        project: options.project,
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

    case "start":
      await startCommand(daemonCommandOptions(options));
      break;

    case "status":
      await statusCommand(daemonCommandOptions(options));
      break;

    case "stop":
      await stopCommand(daemonCommandOptions(options));
      break;

    case "restart":
      await restartCommand(daemonCommandOptions(options));
      break;

    case "config": {
      const sub = options.configSubcommand;
      if (sub?.action === "add") {
        await configAddCommand(sub.options);
      } else if (sub?.action === "remove") {
        await configRemoveCommand(sub.options);
      } else if (sub?.action === "list") {
        await configListCommand(sub.options);
      } else {
        await configCommand();
      }
      break;
    }

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

    case "version":
      console.log(VERSION);
      break;

    case "telemetry":
      await telemetryCommand(options.telemetryAction);
      break;

    case "tools":
      await toolsCommand({
        config: options.config,
        json: options.toolsJson ?? false,
        verbose: options.verbose ?? false,
      });
      break;
  }
}

function daemonCommandOptions(options: CliOptions): DaemonCommandOptions {
  return {
    config: options.config,
    project: options.project,
    host: options.host,
    preferredPort: options.port,
    verbose: options.verbose,
    json: options.json,
  };
}
