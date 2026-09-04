import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import * as p from "@clack/prompts";
import { getScopeLabel, resolveConfigFromPath } from "../config/loader.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import type { UpstreamServer } from "../core/upstream.js";
import {
  ControlPlane,
  ManagementCredentialStore,
  sanitizeText,
  sanitizeUrl,
  type ControlPlaneServer,
  type ControlPlaneSession,
  type ControlPlaneStatus,
} from "../control-plane/index.js";
import {
  type DaemonPaths,
  acquireProfileLock,
  createRuntimeManifest,
  createReadinessSnapshot,
  fingerprintConfigFile,
  getDaemonStatus,
  getDaemonPaths,
  getProjectId,
  isLoopbackHost,
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
const MANAGED_RESTART_TIMEOUT_MS = 30_000;

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
  let controlPlane: ControlPlane | null = null;
  let managementCredentials: ManagementCredentialStore | null = null;
  let restartScheduled = false;
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
      httpPort = options.http ?? config.httpServer?.port ?? DEFAULT_DAEMON_PORT;
    }

    if (isDaemon) {
      const projectPath = resolve(options.project ?? process.cwd());
      const daemonHost = options.host ?? config.httpServer?.host ?? "127.0.0.1";
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
        const incumbentManifest = daemonPaths.runtimeManifest
          ? await readRuntimeManifest(daemonPaths.runtimeManifest)
          : null;
        const incumbentAlive = incumbentManifest
          ? await matchesProcessIdentity(incumbentManifest.processIdentity)
          : incumbent.running;
        if (incumbentAlive) {
          await startupLock.release();
          startupLock = null;
          throw new Error(
            `RouterMCP daemon is already running for this profile (pid ${incumbentManifest?.pid ?? incumbent.pid ?? "unknown"})`,
          );
        }

        if (incumbentManifest && daemonPaths.runtimeManifest) {
          await removeRuntimeManifest(daemonPaths.runtimeManifest);
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

      controlPlane = new ControlPlane({
        getStatus: () =>
          createControlPlaneStatus(runtimeManifest, gateway, daemonPaths, httpPort),
        getServers: () => createControlPlaneServers(gateway),
        getSessions: () => createControlPlaneSessions(gateway, runtimeManifest),
        getLeases: () => gateway?.getConnectionLeases() ?? [],
        restart: async () => {
          if (!daemonPaths || !runtimeManifest) {
            return {
              accepted: false,
              message: "Managed daemon restart is not available",
            };
          }
          if (restartScheduled) {
            return {
              accepted: false,
              message: "A daemon restart is already scheduled",
              state: "stopping",
            };
          }

          restartScheduled = true;
          const stopping = transitionReadiness(readinessFromManifest(runtimeManifest), "stopping");
          runtimeManifest = { ...runtimeManifest, ...stopping };
          await writeRuntimeManifest(daemonPaths.runtimeManifest, runtimeManifest).catch((error) => {
            controlPlane?.recordEvent({
              level: "warn",
              type: "daemon.restart.manifest-error",
              message: `Unable to publish restart state: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
          controlPlane?.recordEvent({
            level: "info",
            type: "daemon.restart",
            message: "Daemon restart scheduled",
          });

          const restartTimer = setTimeout(() => {
            try {
              launchManagedRestart(
                daemonPaths as DaemonPaths,
                runtimeManifest as RuntimeManifest,
                verbose,
                (error) => {
                  restartScheduled = false;
                  controlPlane?.recordEvent({
                    level: "error",
                    type: "daemon.restart.error",
                    message: error?.message ?? "Unable to launch the daemon restart process",
                  });
                },
              );
            } catch (error) {
              restartScheduled = false;
              controlPlane?.recordEvent({
                level: "error",
                type: "daemon.restart.error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }, 0);
          unrefTimer(restartTimer);

          return {
            accepted: true,
            message: "Daemon restart scheduled",
            state: "stopping",
          };
        },
      });
      managementCredentials = new ManagementCredentialStore();
    }

    gateway = createGateway({
      config,
      mode,
      httpPort,
      httpHost: isDaemon
        ? runtimeManifest?.host ?? options.host ?? config.httpServer?.host ?? "127.0.0.1"
        : options.host,
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
              controlPlane: controlPlane ?? undefined,
              managementCredentials: managementCredentials ?? undefined,
            },
      verbose,
      clearOpenApiCache: clearCache,
    });

    setupSignalHandlers(gateway, daemonPaths, () => runtimeManifest, () => controlPlane);

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

      controlPlane?.recordEvent({
        level: "info",
        type: "daemon.ready",
        message: `Daemon ready on port ${actualPort}`,
        metadata: { port: actualPort },
      });

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

function createControlPlaneStatus(
  manifest: RuntimeManifest | null,
  gateway: Gateway | null,
  paths: DaemonPaths | null,
  requestedPort: number | undefined,
): ControlPlaneStatus {
  const host = manifest?.host ?? "127.0.0.1";
  const port = manifest?.port ?? gateway?.getHttpPort() ?? requestedPort ?? 0;
  const fallbackBaseUrl = port > 0 ? `http://${formatHost(host)}:${port}` : "";
  const startedAt = manifest?.startedAt ?? new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const uptimeSeconds = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.round(((Date.now() - startedAtMs) / 1_000) * 100) / 100)
    : 0;

  let state: ControlPlaneStatus["state"] = manifest?.state ?? "offline";
  if (
    state === "ready" &&
    (gateway?.getUpstreamServers().some((server) => server.status === "error" || server.error) ||
      gateway?.getOpenApiServerSnapshots().some((server) => server.status === "error"))
  ) {
    state = "degraded";
  } else if (!manifest) {
    state = gatewayStateToControlState(gateway?.getState());
  }

  return {
    state,
    instanceId: manifest?.instanceId ?? "unknown",
    ...(manifest?.pid ? { pid: manifest.pid } : {}),
    version: manifest?.cliVersion ?? "unknown",
    protocolVersion: manifest?.protocolVersion ?? "unknown",
    profile: manifest?.profileId ?? paths?.profileId ?? "unknown",
    configDigest: manifest?.configFingerprint ?? "unknown",
    host,
    port,
    mcpUrl: manifest?.mcpUrl ?? (fallbackBaseUrl ? `${fallbackBaseUrl}/mcp` : ""),
    controlUrl: manifest?.controlUrl ?? fallbackBaseUrl,
    startedAt,
    uptimeSeconds,
  };
}

function createControlPlaneServers(gateway: Gateway | null): ControlPlaneServer[] {
  if (!gateway) return [];

  const upstreamServers = gateway.getUpstreamServers().map((server) => {
    const state = upstreamStateToControlState(server);
    const url = sanitizeUrl(server.config.url);
    const lastError = server.error ? sanitizeText(server.error.message) : undefined;

    return {
      id: sanitizeText(server.name),
      name: sanitizeText(server.name),
      ...(url ? { url } : {}),
      transport: server.config.transport,
      state,
      toolCount: server.cachedTools.length || server.tools.length,
      ...(server.lastLatencyMs !== undefined && server.lastLatencyMs !== null
        ? { latencyMs: Math.max(0, Math.round(server.lastLatencyMs)) }
        : {}),
      ...(server.lastCheckedAt !== undefined && server.lastCheckedAt !== null
        ? { lastCheckedAt: new Date(server.lastCheckedAt).toISOString() }
        : {}),
      ...(lastError ? { lastError } : {}),
    };
  });

  const openApiServers = gateway.getOpenApiServerSnapshots().map((server) => ({
    id: `openapi:${sanitizeText(server.name)}`,
    name: sanitizeText(server.name),
    ...(server.baseUrl ? { url: sanitizeUrl(server.baseUrl) } : {}),
    transport: "openapi",
    state: openApiStateToControlState(server),
    toolCount: Math.max(0, Math.floor(server.toolCount)),
    ...(server.lastLatencyMs !== undefined
      ? { latencyMs: Math.max(0, Math.round(server.lastLatencyMs)) }
      : {}),
    ...(server.lastCheckedAt !== undefined
      ? { lastCheckedAt: new Date(server.lastCheckedAt).toISOString() }
      : {}),
    ...(server.lastError ? { lastError: sanitizeText(server.lastError) } : {}),
  } satisfies ControlPlaneServer));

  return [...upstreamServers, ...openApiServers];
}

function openApiStateToControlState(
  server: ReturnType<Gateway["getOpenApiServerSnapshots"]>[number],
): ControlPlaneServer["state"] {
  switch (server.status) {
    case "pending":
    case "loading":
      return "starting";
    case "ready":
      return "online";
    case "error":
      return server.toolCount > 0 ? "degraded" : "offline";
  }
}

function createControlPlaneSessions(
  gateway: Gateway | null,
  manifest: RuntimeManifest | null,
): ControlPlaneSession[] {
  if (!gateway) return [];

  const profile = manifest?.profileId;
  const sessions: ControlPlaneSession[] = gateway.getSessionSnapshots().map((session) => ({
    id: `mcp:${session.id}`,
    kind: "mcp",
    clientName: session.clientName ?? "MCP client",
    ...(session.clientVersion ? { clientVersion: session.clientVersion } : {}),
    ...(profile ? { profile } : {}),
    state: session.state,
    connectedAt: new Date(session.createdAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
  }));

  const now = Date.now();
  for (const lease of gateway.getConnectionLeases()) {
    sessions.push({
      id: `bridge:${lease.leaseId}`,
      kind: "bridge",
      clientName: "stdio bridge",
      ...(profile ? { profile } : {}),
      state: Date.parse(lease.leaseExpiresAt) > now ? "active" : "expired",
      connectedAt: lease.connectedAt,
      lastSeenAt: lease.lastSeenAt,
      leaseExpiresAt: lease.leaseExpiresAt,
    });
  }

  return sessions.sort((left, right) => {
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}

function upstreamStateToControlState(
  server: UpstreamServer,
): ControlPlaneServer["state"] {
  switch (server.status) {
    case "connected":
    case "discovered":
      return "online";
    case "connecting":
      return "starting";
    case "error":
      return hasCachedCapabilities(server) ? "degraded" : "offline";
    case "disabled":
    case "disconnected":
      return "offline";
  }
}

function hasCachedCapabilities(server: UpstreamServer): boolean {
  return (
    server.cachedTools.length > 0 ||
    server.cachedResources.length > 0 ||
    server.cachedPrompts.length > 0
  );
}

function gatewayStateToControlState(
  state: ReturnType<Gateway["getState"]> | undefined,
): ControlPlaneStatus["state"] {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
      return "ready";
    case "stopping":
      return "stopping";
    case "error":
      return "failed";
    default:
      return "offline";
  }
}

interface CliRuntimeCommand {
  command: string;
  args: string[];
}

function launchManagedRestart(
  paths: DaemonPaths,
  manifest: RuntimeManifest,
  verbose: boolean,
  onError: (error?: Error) => void,
): void {
  const script = process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (!script) throw new Error("Unable to determine the RouterMCP CLI entrypoint for restart");

  const runtime = getCliRuntimeCommand(script);
  const args = [
    ...runtime.args,
    script,
    "restart",
    "--config",
    manifest.configPath,
    "--project",
    paths.projectPath,
    "--host",
    manifest.host,
  ];
  if (manifest.port) args.push("--port", String(manifest.port));
  if (verbose) args.push("--verbose");

  const env = { ...process.env };
  delete env.ROUTERMCP_DAEMON;
  delete env.ROUTERMCP_DAEMON_LOCK_HELD;

  const child = spawn(runtime.command, args, {
    cwd: paths.projectPath,
    detached: true,
    stdio: "ignore",
    env,
  });
  let finished = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: Error): void => {
    if (finished) return;
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    if (error) onError(error);
  };

  child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  child.once("exit", (code, signal) => {
    if (code === 0) {
      finish();
      return;
    }
    finish(
      new Error(
        `Managed daemon restart exited unsuccessfully${code === null ? ` from ${signal ?? "a signal"}` : ` with code ${code}`}`,
      ),
    );
  });
  watchdog = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited between the watchdog firing and signal delivery.
    }
    finish(new Error(`Managed daemon restart did not complete within ${MANAGED_RESTART_TIMEOUT_MS}ms`));
  }, MANAGED_RESTART_TIMEOUT_MS);
  unrefTimer(watchdog);
  child.unref();
}

function getCliRuntimeCommand(script: string): CliRuntimeCommand {
  if (extname(script) === ".ts" && !isBunRuntime()) {
    return { command: "bun", args: [] };
  }
  return { command: process.execPath, args: [] };
}

function isBunRuntime(): boolean {
  return typeof globalThis.Bun !== "undefined" || /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as unknown as { unref?: () => void };
  maybeTimer.unref?.();
}

function setupSignalHandlers(
  gateway: Gateway,
  daemonPaths: DaemonPaths | null,
  getRuntimeManifest: () => RuntimeManifest | null,
  getControlPlane: () => ControlPlane | null,
): void {
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.error(`\nReceived ${signal}, shutting down...`);
    try {
      const manifest = getRuntimeManifest();
      if (manifest && daemonPaths?.runtimeManifest) {
        await markManifestStopping(daemonPaths, manifest);
      }
      if (manifest) {
        getControlPlane()?.recordEvent({
          level: "info",
          type: "daemon.stopping",
          message: `Daemon stopping after ${signal}`,
        });
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

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
