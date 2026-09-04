import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveConfig } from "../config/loader.js";
import {
  getDaemonPaths,
  getDaemonStatus,
  getProjectId,
  ensureRunning,
} from "../daemon/index.js";
import { ConfigError, RouterMcpError } from "../utils/errors.js";

export interface ConnectCommandOptions {
  config?: string;
  project?: string;
  verbose?: boolean;
}

export async function connectCommand(options: ConnectCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;
  const projectPath = options.project ?? process.cwd();

  const log = (msg: string) => {
    if (verbose) console.error(`[connect] ${msg}`);
  };

  // Info messages go to stderr (stdout is reserved for MCP protocol)
  const info = (msg: string) => {
    console.error(msg);
  };

  try {
    let configPath: string;

    if (options.config) {
      // Explicit config path provided
      configPath = resolve(options.config);
    } else {
      // Resolve config using priority-based resolution
      const resolved = await resolveConfig(projectPath);
      if (!resolved) {
        throw new ConfigError("No config file found. Run 'routermcp config' to create one.");
      }
      configPath = resolve(resolved.path);
      log(`Resolved config scope: ${resolved.scope}`);
    }

    log(`Using config: ${configPath}`);

    const projectId = getProjectId(projectPath);
    log(`Project ID: ${projectId}`);

    const paths = getDaemonPaths(projectId, configPath, resolve(projectPath));
    log(`Daemon dir: ${paths.dir}`);

    const previousStatus = await getDaemonStatus(paths);
    log(`Daemon status: ${previousStatus.running ? "running" : "stopped"}`);
    const wasRunning = previousStatus.running;
    if (!wasRunning) info("Starting daemon...");
    const status = await ensureRunning(paths, {
      verbose,
      projectPath: resolve(projectPath),
    });

    // The managed daemon uses authenticated loopback HTTP as its single
    // transport. Unix socket support was previously advertised without a
    // corresponding server listener, so do not route clients through a
    // stale/legacy socket path.
    if (status.port) {
      if (wasRunning) {
        info(`Connected to daemon at ${projectPath} (pid: ${status.pid}, port: ${status.port})`);
      } else {
        info(`Daemon started at ${projectPath} (pid: ${status.pid}, port: ${status.port})`);
      }
      await proxyStdioToHttp(`http://127.0.0.1:${status.port}/mcp`, log);
    } else {
      throw new Error("Daemon did not report socket or HTTP port");
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RouterMcpError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function proxyStdioToHttp(url: string, log: (msg: string) => void): Promise<void> {
  const sessionId = crypto.randomUUID();
  log(`HTTP proxy to: ${url} (session: ${sessionId})`);

  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);
      log(`stdin -> daemon: ${JSON.stringify(message).substring(0, 100)}...`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`HTTP error: ${response.status} ${errorText}`);
        return;
      }

      const responseText = await response.text();
      if (responseText) {
        log(`daemon -> stdout: ${responseText.substring(0, 100)}...`);
        process.stdout.write(`${responseText}\n`);
      }
    } catch (err) {
      console.error(`Error processing message: ${err}`);
    }
  });

  rl.on("close", () => {
    log("stdin closed");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });
}
