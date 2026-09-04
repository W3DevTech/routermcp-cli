import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { getScopeLabel, resolveConfigFromPath } from "../config/loader.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import {
  type DaemonPaths,
  acquireProfileLock,
  createRuntimeManifest,
  createReadinessSnapshot,
  fingerprintConfigFile,
  getDaemonStatus,
  getDaemonPaths,
  getProjectId,
  matchesProcessIdentity,
  readRuntimeManifest,
  removeRuntimeManifest,
  type RuntimeManifest,
  transitionReadiness,
  writeRuntimeManifest,
} from "../daemon/index.js";
import { ConfigError, RouterMcpError } from "../utils/errors.js";
import { configCommand } from "./config.js";

export interface ServeCommandOptions {
  config?: string;
  stdio?: boolean;
  http?: number;
  host?: string;
  verbose?: boolean;
  daemonMode?: boolean;
  project?: string;
  socket?: string;
  clearCache?: boolean;
}

const DEFAULT_DAEMON_PORT = 7858;

export async function serveCommand(options: ServeCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;
  const isDaemon = options.daemonMode ?? false;
  const clearCache = options.clearCache ?? false;

  let mode: "stdio" | "http-streamable" = options.http ? "http-streamable" : "stdio";
  let httpPort = options.http;

  if (isDaemon) {
    mode = "http-streamable";
    httpPort = httpPort ?? DEFAULT_DAEMON_PORT;
  }

  let daemonPaths: DaemonPaths | null = null;
  let runtimeManifest: RuntimeManifest | null = null;
  let gateway: Gateway | null = null;
  let startupLock: Awaited<ReturnType<typeof acquireProfileLock>> | null = null;

  try {
    if (options.socket) {
      throw new RouterMcpError(
        "Unix socket transport is not available; use the managed loopback HTTP transport",
        "UNSUPPORTED_SOCKET_TRANSPORT",
      );
    }

    const { config, path: configPath, scope } = await resolveConfigFromPath(options.config);

    if (verbose) {
      console.error(`Loaded config from: ${configPath} [${getScopeLabel(scope)}]`);
      console.error(`Configured servers: ${Object.keys(config.mcpServers).join(", ")}`);
    }

    if (isDaemon) {
      const projectPath = resolve(options.project ?? process.cwd());
      const daemonHost = options.host ?? "127.0.0.1";
      if (!isLoopbackHost(daemonHost)) {
        throw new RouterMcpError(
          `Daemon host must be loopback (received ${daemonHost})`,
          "INVALID_DAEMON_HOST",
        );
      }
      const projectId = getProjectId(projectPath);
      daemonPaths = getDaemonPaths(projectId, resolve(configPath), projectPath);

      // The supervisor keeps this lock while the child reaches ready. A
      // manually launched daemon must acquire it itself so two direct
      // `serve --daemon-mode` invocations cannot overwrite one profile.
      if (process.env.ROUTERMCP_DAEMON_LOCK_HELD !== "1") {
        startupLock = await acquireProfileLock(daemonPaths.lock);
        const incumbent = await getDaemonStatus(daemonPaths);
        if (incumbent.running) {
          await startupLock.release();
          startupLock = null;
          throw new Error(
            `RouterMCP daemon is already running for this profile (pid ${incumbent.pid ?? "unknown"})`,
          );
        }
      }

      if (daemonPaths.runtimeManifest) {
        const configFingerprint = await fingerprintConfigFile(daemonPaths.configPath);
        runtimeManifest = await createRuntimeManifest({
          projectId,
          profileId: daemonPaths.profileId,
          configPath: daemonPaths.configPath,
          configFingerprint,
          pid: process.pid,
          host: daemonHost,
          port: httpPort,
          localAuthToken: randomBytes(32).toString("base64url"),
        });
        await writeRuntimeManifest(daemonPaths.runtimeManifest, runtimeManifest);
      } else {
        // Compatibility path for callers with a pre-contract DaemonPaths
        // object. Production paths always use runtime.json.
        mkdirSync(daemonPaths.dir, { recursive: true });
        writeFileSync(daemonPaths.pid, String(process.pid));
      }

      if (verbose) {
        console.error(`[daemon] Project ID: ${projectId}`);
        console.error(
          `[daemon] Runtime manifest: ${daemonPaths.runtimeManifest ?? daemonPaths.pid}`,
        );
      }
    }

    gateway = createGateway({
      config,
      mode,
      httpPort,
      httpHost: isDaemon ? options.host ?? "127.0.0.1" : options.host,
      httpOptions:
        runtimeManifest === null
          ? undefined
          : {
              authToken: runtimeManifest.localAuthToken,
              health: () => ({
                instanceId: runtimeManifest?.instanceId,
                profileId: runtimeManifest?.profileId,
                pid: runtimeManifest?.pid,
                state: runtimeManifest?.state,
                cliVersion: runtimeManifest?.cliVersion,
                protocolVersion: runtimeManifest?.protocolVersion,
                configFingerprint: runtimeManifest?.configFingerprint,
                host: runtimeManifest?.host,
                port: runtimeManifest?.port,
                readyAt: runtimeManifest?.readyAt,
              }),
            },
      verbose,
      clearOpenApiCache: clearCache,
    });

    setupSignalHandlers(gateway, daemonPaths, () => runtimeManifest);

    await gateway.start();

    if (isDaemon && daemonPaths && runtimeManifest) {
      const actualPort = gateway.getHttpPort() ?? httpPort;
      if (!actualPort) {
        throw new Error("Daemon HTTP transport did not report a bound port");
      }

      const ready = transitionReadiness(
        readinessFromManifest(runtimeManifest),
        "ready",
      );
      runtimeManifest = {
        ...runtimeManifest,
        ...ready,
        port: actualPort,
        mcpUrl: `http://${formatHost(runtimeManifest.host)}:${actualPort}/mcp`,
        controlUrl: `http://${formatHost(runtimeManifest.host)}:${actualPort}`,
      };
      await writeRuntimeManifest(daemonPaths.runtimeManifest, runtimeManifest);
      if (verbose) {
        console.error(`[daemon] Runtime manifest published as ready on port ${actualPort}`);
      }

      if (startupLock) {
        await startupLock.release();
        startupLock = null;
      }
    } else if (isDaemon && daemonPaths) {
      // Compatibility path for callers with a pre-contract DaemonPaths
      // object. Production paths use the manifest's actual bound port.
      writeFileSync(daemonPaths.port, String(httpPort));
    }

    if (mode === "stdio") {
      await new Promise(() => {});
    }
  } catch (err) {
    if (startupLock) {
      await startupLock.release().catch(() => undefined);
      startupLock = null;
    }
    if (gateway) {
      await gateway.stop().catch(() => undefined);
    }
    if (runtimeManifest && daemonPaths?.runtimeManifest) {
      await removeRuntimeManifestIfCurrent(daemonPaths, runtimeManifest);
      runtimeManifest = null;
    }

    // Handle missing config file with interactive prompt
    if (err instanceof ConfigError && err.message.includes("No config file found")) {
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

function setupSignalHandlers(
  gateway: Gateway,
  daemonPaths: DaemonPaths | null,
  getRuntimeManifest: () => RuntimeManifest | null,
): void {
  const shutdown = async (signal: string) => {
    console.error(`\nReceived ${signal}, shutting down...`);
    try {
      const manifest = getRuntimeManifest();
      if (manifest && daemonPaths?.runtimeManifest) {
        await markManifestStopping(daemonPaths, manifest);
      }
      await gateway.stop();
      if (manifest && daemonPaths?.runtimeManifest) {
        await removeRuntimeManifestIfCurrent(daemonPaths, manifest);
      }
      cleanupLegacyDaemonFiles(daemonPaths);
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      cleanupLegacyDaemonFiles(daemonPaths);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function cleanupLegacyDaemonFiles(paths: DaemonPaths | null): void {
  if (!paths) return;

  for (const file of [paths.pid, paths.port, paths.socket]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors after the process has stopped.
    }
  }
}

function readinessFromManifest(manifest: RuntimeManifest): ReturnType<typeof createReadinessSnapshot> {
  return {
    state: manifest.state,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    ...(manifest.readyAt ? { readyAt: manifest.readyAt } : {}),
    ...(manifest.failedAt ? { failedAt: manifest.failedAt } : {}),
    ...(manifest.stoppingAt ? { stoppingAt: manifest.stoppingAt } : {}),
    ...(manifest.error ? { error: manifest.error } : {}),
  };
}

async function markManifestStopping(paths: DaemonPaths, manifest: RuntimeManifest): Promise<void> {
  const current = await readRuntimeManifest(paths.runtimeManifest);
  if (!current || current.instanceId !== manifest.instanceId) return;
  if (!(await matchesProcessIdentity(current.processIdentity))) return;

  const stopping =
    current.state === "stopping"
      ? readinessFromManifest(current)
      : transitionReadiness(readinessFromManifest(current), "stopping");
  await writeRuntimeManifest(paths.runtimeManifest, { ...current, ...stopping });
}

async function removeRuntimeManifestIfCurrent(
  paths: DaemonPaths,
  manifest: RuntimeManifest,
): Promise<void> {
  const current = await readRuntimeManifest(paths.runtimeManifest);
  if (current?.instanceId === manifest.instanceId) {
    await removeRuntimeManifest(paths.runtimeManifest);
  }
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    host.startsWith("127.")
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
