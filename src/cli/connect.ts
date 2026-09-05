import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveConfig, resolveConfigFromPath } from "../config/loader.js";
import type { ConfigScope } from "../config/types.js";
import {
  ensureRunning,
  ensureWorkspaceRunning,
  fingerprintConfigFile,
  getDaemonPaths,
  getDaemonStatus,
  getProjectId,
  getWorkspaceDaemonStatus,
  type DaemonStatus,
} from "../daemon/index.js";
import type { ConnectionLease } from "../daemon/connection-tracker.js";
import {
  DAEMON_BRIDGE_LEASE_HEADER,
  DAEMON_BRIDGE_LEASES_PATH,
  DAEMON_WORKSPACE_HEADER,
  type BridgeLeaseMetadata,
} from "../transports/index.js";
import { ConfigError, RouterMcpError } from "../utils/errors.js";

export interface ConnectCommandOptions {
  config?: string;
  project?: string;
  host?: string;
  preferredPort?: number;
  verbose?: boolean;
}

/**
 * Connect stdio to the profile daemon. The daemon lifecycle is deliberately
 * owned by ensureRunning so every caller shares the same locking, readiness,
 * and stale-manifest handling.
 */
export async function connectCommand(options: ConnectCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;
  const projectPath = resolve(options.project ?? process.cwd());

  const log = (msg: string) => {
    if (verbose) console.error(`[connect] ${msg}`);
  };

  try {
    let configPath: string;
    let configScope: ConfigScope;
    let configuredHost: string | undefined;
    let configuredPort: number | undefined;

    if (options.config) {
      const resolved = await resolveConfigFromPath(options.config, projectPath);
      configPath = resolve(resolved.path);
      configScope = resolved.scope;
      configuredHost = resolved.config.httpServer?.host;
      configuredPort = resolved.config.httpServer?.port;
    } else {
      const resolved = await resolveConfig(projectPath);
      if (!resolved) {
        throw new ConfigError("No config file found. Run 'routermcp config' to create one.");
      }
      configPath = resolve(resolved.path);
      configScope = resolved.scope;
      configuredHost = resolved.config.httpServer?.host;
      configuredPort = resolved.config.httpServer?.port;
      log(`Resolved config scope: ${resolved.scope}`);
    }

    log(`Using config: ${configPath}`);

    const profilePaths = getDaemonPaths(getProjectId(projectPath), configPath, projectPath);
    const useWorkspaceHost = Boolean(profilePaths.runtimeManifest && profilePaths.profileId);
    const configFingerprint = useWorkspaceHost
      ? await fingerprintConfigFile(configPath)
      : "0".repeat(64);
    const workspace = {
      directory: projectPath,
      configPath,
      configScope,
      configDigest: configFingerprint,
    };
    log(`Project ID: ${getProjectId(projectPath)}`);
    log(`Workspace directory: ${projectPath}`);

    // Keep the status probe for useful diagnostics while ensureRunning owns
    // the authoritative check/start/readiness window under its profile lock.
    const previousStatus = useWorkspaceHost
      ? await getWorkspaceDaemonStatus(workspace)
      : await getDaemonStatus(profilePaths);
    log(`Daemon status: ${previousStatus.running ? "running" : "stopped"}`);
    const wasRunning = previousStatus.running;
    if (!wasRunning) info("Starting daemon...");

    const status = useWorkspaceHost
      ? await ensureWorkspaceRunning(workspace, {
          projectPath,
          host: options.host ?? configuredHost,
          preferredPort: options.preferredPort ?? configuredPort,
          verbose,
        })
      : await ensureRunning(profilePaths, {
          projectPath,
          host: options.host ?? configuredHost,
          preferredPort: options.preferredPort ?? configuredPort,
          verbose,
        });
    if (!status.running) {
      throw new Error(status.reason ?? "Daemon did not become ready");
    }

    const mcpUrl = status.mcpUrl ?? daemonMcpUrl(status);
    if (!mcpUrl) {
      throw new Error("Daemon did not report an MCP URL or HTTP port");
    }

    if (wasRunning) {
      info(`Connected to daemon at ${projectPath} (pid: ${status.pid}, url: ${mcpUrl})`);
    } else {
      info(`Daemon started at ${projectPath} (pid: ${status.pid}, url: ${mcpUrl})`);
    }
    await proxyStdioToHttp(mcpUrl, log, status.authToken, {
      directory: projectPath,
      configPath,
      configScope,
      // The status for a reused host describes its primary profile. Lease
      // metadata must describe the workspace requested by this bridge, or a
      // second directory using the same config would be attributed to the
      // primary profile. The daemon recomputes the profile ID after resolving
      // symlinks, so this request intentionally omits the optional claim.
      configDigest: configFingerprint,
    });
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RouterMcpError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function info(message: string): void {
  // stdout is reserved for newline-delimited MCP JSON-RPC.
  console.error(message);
}

function daemonMcpUrl(status: DaemonStatus): string | null {
  if (!status.port) return null;
  const host = status.host ?? "127.0.0.1";
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${status.port}/mcp`;
}

/**
 * Bridge one stdio client to the daemon's authenticated HTTP transport.
 * Requests are intentionally serialized: stdio clients associate responses
 * with request IDs, but some consumers still depend on response order.
 */
export async function proxyStdioToHttp(
  url: string,
  log: (msg: string) => void,
  authToken?: string,
  workspace?: BridgeLeaseMetadata,
): Promise<void> {
  const mcpUrl = new URL(url);
  const leaseUrl = new URL(DAEMON_BRIDGE_LEASES_PATH, mcpUrl.origin).toString();
  const authHeaders: Record<string, string> = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : {};

  const lease = await acquireBridgeLease(leaseUrl, authHeaders, workspace);
  let activeLease = lease;
  let sessionId: string = randomUUID();
  let acceptingInput = true;
  let requestQueue = Promise.resolve();
  let cleanupPromise: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let bridgeError: Error | null = null;

  const failBridge = (error: unknown): void => {
    bridgeError ??= error instanceof Error ? error : new Error(String(error));
    acceptingInput = false;
  };

  const cleanup = async (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;

    acceptingInput = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    cleanupPromise = (async () => {
      // Drain messages already accepted from stdin before terminating the
      // session. This prevents a close event from racing an in-flight call.
      await requestQueue;

      await closeMcpSession(mcpUrl, sessionId, bridgeContextHeaders(activeLease, authHeaders), log);
      await releaseBridgeLease(
        leaseUrl,
        activeLease.leaseId,
        bridgeContextHeaders(activeLease, authHeaders),
        log,
      );
    })();

    return cleanupPromise;
  };

  const heartbeatIntervalMs = Math.max(1, Math.floor(lease.leaseTtlMs / 3));
  try {
    heartbeatTimer = setInterval(() => {
      void heartbeatBridgeLease(
        leaseUrl,
        activeLease.leaseId,
        bridgeContextHeaders(activeLease, authHeaders),
      )
        .then((nextLease) => {
          activeLease = nextLease;
        })
        .catch((err: unknown) => {
          log(`Lease heartbeat failed: ${errorMessage(err)}`);
          failBridge(new Error(`Daemon bridge lease heartbeat failed: ${errorMessage(err)}`));
        });
    }, heartbeatIntervalMs);
    unrefTimer(heartbeatTimer);

    const rl = createInterface({ input: process.stdin });

    const enqueue = (line: string): void => {
      if (!acceptingInput || !line.trim()) return;

      requestQueue = requestQueue
        .then(() =>
          forwardMcpMessage(
            mcpUrl,
            line,
            sessionId,
            bridgeContextHeaders(activeLease, authHeaders),
            log,
          ),
        )
        .then((nextSessionId) => {
          if (nextSessionId) sessionId = nextSessionId;
        })
        .catch((err: unknown) => {
          failBridge(err);
          console.error(`Error processing message: ${errorMessage(err)}`);
        });
    };

    await new Promise<void>((resolveBridge, rejectBridge) => {
      let finished = false;
      let errorTimer: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (errorTimer) {
          clearInterval(errorTimer);
          errorTimer = null;
        }
        void cleanup()
          .catch((err: unknown) => {
            console.error(`Bridge cleanup failed: ${errorMessage(err)}`);
          })
          .finally(() => {
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            if (bridgeError) {
              rejectBridge(bridgeError);
            } else {
              resolveBridge();
            }
          });
      };

      const onSignal = () => {
        try {
          rl.close();
        } finally {
          finish();
        }
      };

      rl.on("line", enqueue);
      rl.once("close", finish);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      const checkForBridgeError = () => {
        if (bridgeError && !finished) {
          try {
            rl.close();
          } finally {
            finish();
          }
        }
      };
      const timer = setInterval(checkForBridgeError, 25);
      errorTimer = timer;
      unrefTimer(timer);
    });
  } catch (err) {
    await cleanup().catch((cleanupErr: unknown) => {
      console.error(`Bridge cleanup failed: ${errorMessage(cleanupErr)}`);
    });
    throw err;
  }
}

async function acquireBridgeLease(
  leaseUrl: string,
  authHeaders: Record<string, string>,
  workspace?: BridgeLeaseMetadata,
): Promise<ConnectionLease> {
  const headers: Record<string, string> = { ...authHeaders };
  const body = workspace ? JSON.stringify(workspace) : undefined;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(leaseUrl, {
    method: "POST",
    headers,
    ...(body ? { body } : {}),
  });
  if (!response.ok) {
    throw new Error(`Unable to acquire daemon bridge lease (${response.status})`);
  }

  const payload: unknown = await response.json();
  if (!isConnectionLease(payload)) {
    throw new Error("Daemon returned an invalid bridge lease");
  }
  return payload;
}

async function heartbeatBridgeLease(
  leaseUrl: string,
  leaseId: string,
  authHeaders: Record<string, string>,
): Promise<ConnectionLease> {
  const response = await fetch(`${leaseUrl}/${encodeURIComponent(leaseId)}/heartbeat`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!response.ok) {
    throw new Error(`Daemon bridge lease heartbeat returned ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isConnectionLease(payload)) {
    throw new Error("Daemon returned an invalid bridge lease heartbeat");
  }
  return payload;
}

/** Carry the server-owned lease/workspace identity into the MCP session. */
function bridgeContextHeaders(
  lease: Pick<ConnectionLease, "leaseId" | "workspaceId">,
  authHeaders: Record<string, string>,
): Record<string, string> {
  return {
    ...authHeaders,
    [DAEMON_BRIDGE_LEASE_HEADER]: lease.leaseId,
    ...(lease.workspaceId ? { [DAEMON_WORKSPACE_HEADER]: lease.workspaceId } : {}),
  };
}

async function releaseBridgeLease(
  leaseUrl: string,
  leaseId: string,
  authHeaders: Record<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const response = await fetch(`${leaseUrl}/${encodeURIComponent(leaseId)}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!response.ok && response.status !== 404) {
      log(`Daemon bridge lease release returned ${response.status}`);
    }
  } catch (err) {
    log(`Daemon bridge lease release failed: ${errorMessage(err)}`);
  }
}

async function closeMcpSession(
  mcpUrl: URL,
  sessionId: string,
  authHeaders: Record<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const response = await fetch(mcpUrl, {
      method: "DELETE",
      headers: {
        ...authHeaders,
        "Mcp-Session-Id": sessionId,
      },
    });
    if (!response.ok && response.status !== 404) {
      log(`MCP session cleanup returned ${response.status}`);
    }
  } catch (err) {
    log(`MCP session cleanup failed: ${errorMessage(err)}`);
  }
}

async function forwardMcpMessage(
  mcpUrl: URL,
  line: string,
  sessionId: string,
  authHeaders: Record<string, string>,
  log: (msg: string) => void,
): Promise<string | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error("stdin message is not valid JSON");
  }

  log(`stdin -> daemon: ${JSON.stringify(message).substring(0, 100)}...`);

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify(message),
  });

  const responseSessionId = response.headers.get("mcp-session-id");
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}${responseText ? ` ${responseText}` : ""}`);
  }

  const output = responseText.trim();
  if (output) {
    log(`daemon -> stdout: ${output.substring(0, 100)}...`);
    process.stdout.write(`${output}\n`);
  }

  return responseSessionId;
}

function isConnectionLease(value: unknown): value is ConnectionLease {
  if (!isRecord(value)) return false;
  return (
    typeof value.leaseId === "string" &&
    typeof value.connectedAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    typeof value.leaseExpiresAt === "string" &&
    typeof value.leaseTtlMs === "number" &&
    Number.isFinite(value.leaseTtlMs) &&
    value.leaseTtlMs > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybeTimer = timer as unknown as { unref?: () => void };
  maybeTimer.unref?.();
}
