import * as p from "@clack/prompts";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfigFromPath } from "../config/loader.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import { ConfigError, RouterMcpError } from "../utils/errors.js";
import { configCommand } from "./config.js";
import { getProjectId, getDaemonPaths, type DaemonPaths } from "../daemon/index.js";

export interface ServeCommandOptions {
  config?: string;
  stdio?: boolean;
  http?: number;
  verbose?: boolean;
  daemonMode?: boolean;
  socket?: string;
}

const DEFAULT_DAEMON_PORT = 5151;
const DAEMON_IDLE_TIMEOUT = 10000;
const DAEMON_IDLE_CHECK_INTERVAL = 2000;

export async function serveCommand(options: ServeCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;
  const isDaemon = options.daemonMode ?? false;

  let mode: "stdio" | "http-streamable" = options.http ? "http-streamable" : "stdio";
  let httpPort = options.http;

  if (isDaemon) {
    mode = "http-streamable";
    httpPort = httpPort ?? DEFAULT_DAEMON_PORT;
  }

  let daemonPaths: DaemonPaths | null = null;

  try {
    const { config, path: configPath } = await loadConfigFromPath(options.config);

    if (verbose) {
      console.error(`Loaded config from: ${configPath}`);
      console.error(`Configured servers: ${Object.keys(config.mcpServers).join(", ")}`);
    }

    if (isDaemon) {
      const projectDir = dirname(resolve(configPath));
      const projectId = getProjectId(projectDir);
      daemonPaths = getDaemonPaths(projectId, resolve(configPath));

      mkdirSync(daemonPaths.dir, { recursive: true });
      writeFileSync(daemonPaths.pid, String(process.pid));

      if (verbose) {
        console.error(`[daemon] Project ID: ${projectId}`);
        console.error(`[daemon] PID file: ${daemonPaths.pid}`);
      }
    }

    const gateway = createGateway({
      config,
      mode,
      httpPort,
      verbose,
    });

    setupSignalHandlers(gateway, daemonPaths);

    await gateway.start();

    if (isDaemon && daemonPaths) {
      writeFileSync(daemonPaths.port, String(httpPort));
      if (verbose) {
        console.error(`[daemon] Port file written: ${daemonPaths.port}`);
      }

      startIdleShutdownMonitor(gateway, daemonPaths, verbose);
    }

    if (mode === "stdio") {
      await new Promise(() => {});
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

function setupSignalHandlers(gateway: Gateway, daemonPaths: DaemonPaths | null): void {
  const shutdown = async (signal: string) => {
    console.error(`\nReceived ${signal}, shutting down...`);
    try {
      await gateway.stop();
      cleanupDaemonFiles(daemonPaths);
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      cleanupDaemonFiles(daemonPaths);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function cleanupDaemonFiles(paths: DaemonPaths | null): void {
  if (!paths) return;

  for (const file of [paths.pid, paths.port, paths.socket]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

function startIdleShutdownMonitor(
  gateway: Gateway,
  daemonPaths: DaemonPaths,
  verbose: boolean
): void {
  let idleStart: number | null = null;

  const checkIdle = () => {
    const stats = gateway.getSessionStats();
    const activeSessions = stats?.activeSessions ?? 0;

    if (activeSessions === 0) {
      if (idleStart === null) {
        idleStart = Date.now();
        if (verbose) {
          console.error("[daemon] No active sessions, starting idle timer");
        }
      } else if (Date.now() - idleStart >= DAEMON_IDLE_TIMEOUT) {
        if (verbose) {
          console.error("[daemon] Idle timeout reached, shutting down");
        }
        gateway.stop().then(() => {
          cleanupDaemonFiles(daemonPaths);
          process.exit(0);
        });
        return;
      }
    } else {
      if (idleStart !== null && verbose) {
        console.error(`[daemon] Activity detected (${activeSessions} sessions), resetting idle timer`);
      }
      idleStart = null;
    }

    setTimeout(checkIdle, DAEMON_IDLE_CHECK_INTERVAL);
  };

  setTimeout(checkIdle, DAEMON_IDLE_CHECK_INTERVAL);
}
