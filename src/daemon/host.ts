import { resolve } from "node:path";
import { RouterMcpError } from "../utils/errors.js";
import {
  type DaemonStatus,
  ensureRunning,
  getDaemonStatus,
  type EnsureRunningOptions,
  type StopDaemonOptions,
  stopDaemonProcess,
  stopDaemon,
} from "./lifecycle.js";
import { acquireProfileLock } from "./lock.js";
import { getDaemonHostPaths, getDaemonPaths } from "./paths.js";
import { matchesProcessIdentity } from "./identity.js";
import { getProjectId } from "./project.js";
import { DAEMON_HEALTH_PATH } from "../transports/http-streamable.js";
import {
  createDaemonHostManifest,
  getDaemonHostCompatibility,
  hasDaemonHostCapabilities,
  type DaemonHostManifest,
  readDaemonHostManifest,
  removeDaemonHostManifest,
  writeDaemonHostManifest,
} from "./host-manifest.js";
import {
  type WorkspaceRegistrationInput,
  WorkspaceRegistry,
  type WorkspaceSnapshot,
} from "./workspace-registry.js";

/** Status returned when a workspace is attached to the reusable host. */
export interface WorkspaceDaemonStatus extends DaemonStatus {
  hostId: string;
  workspaceId: string;
  projectPath: string;
}

export class DaemonHostProfileConflictError extends RouterMcpError {
  constructor(message: string) {
    super(message, "DAEMON_HOST_PROFILE_CONFLICT");
    this.name = "DaemonHostProfileConflictError";
  }
}

export class DaemonHostBusyError extends RouterMcpError {
  constructor(message: string) {
    super(message, "DAEMON_HOST_BUSY");
    this.name = "DaemonHostBusyError";
  }
}

export interface EnsureWorkspaceDaemonOptions extends EnsureRunningOptions {
  registry?: WorkspaceRegistry;
  /** Internal restart may replace the host while other workspaces reconnect. */
  allowActiveWorkspaces?: boolean;
}

/**
 * Ensure a workspace is reachable through one user-scoped daemon host.
 *
 * The first workspace starts using the existing profile lifecycle. Later
 * workspaces reuse the same user-scoped process regardless of their config
 * path or revision. The authenticated bridge metadata carries the workspace
 * identity into the host, where the runtime manager selects the isolated
 * context for that request.
 */
export async function ensureWorkspaceRunning(
  input: WorkspaceRegistrationInput,
  options: EnsureWorkspaceDaemonOptions = {},
): Promise<WorkspaceDaemonStatus> {
  const registry = options.registry ?? new WorkspaceRegistry();
  const descriptor = await registry.describe(input);
  const profilePaths = getDaemonPaths(
    getProjectId(descriptor.directory),
    descriptor.configPath,
    descriptor.directory,
  );
  const hostPaths = getDaemonHostPaths();
  // Keep a durable record even when this workspace cannot attach yet. The
  // console can then explain that the profile is unavailable instead of
  // making a failed directory disappear from the inventory.
  const workspace = await registry.ensure(input);
  const lock = await acquireProfileLock(hostPaths.lock, {
    timeoutMs: options.lockTimeoutMs,
  });

  try {
    const hostManifest = await readDaemonHostManifest(hostPaths.runtimeManifest);
    if (hostManifest) {
      const existing = await getHostDaemonStatus(hostManifest, options.healthTimeoutMs);
      if (existing.running) {
        // Registration and context construction happen in the host process as
        // part of bridge lease acquisition. Returning the shared endpoint here
        // keeps the CLI starter independent from runtime-manager internals.
        return attachWorkspaceStatus(existing, hostManifest.hostId, workspace);
      }

      const hostProcessAlive = await matchesProcessIdentity(hostManifest.processIdentity);
      const compatibility = getDaemonHostCompatibility(hostManifest);

      if (!compatibility.compatible && hostProcessAlive) {
        const activeOther = registry
          .listSync()
          .some((registered) => registered.activeConnections > 0);
        if (activeOther && options.allowActiveWorkspaces !== true) {
          throw new DaemonHostBusyError(
            `${compatibility.reason ?? "The RouterMCP daemon host is incompatible"}; ` +
              "active workspaces must disconnect before it can be upgraded",
          );
        }

        // A stale host must be replaced before another process can bind the
        // shared listener. Stop only the exact recorded process identity;
        // never infer ownership from a PID or port file alone.
        await stopDaemonProcess(hostManifest.processIdentity, options);
        if (await matchesProcessIdentity(hostManifest.processIdentity)) {
          throw new DaemonHostBusyError(
            "The incompatible RouterMCP daemon host could not be stopped safely",
          );
        }
        // Lease counts belong to the old host and may be reset only after the
        // recorded identity has been confirmed dead.
        await registry.resetActiveConnections();
        await removeDaemonHostManifest(hostPaths.runtimeManifest);
      } else if (hostProcessAlive) {
        // A fresh host can briefly be between its durable manifest write and
        // the first successful health response. Do not start a second process
        // while that identity is still alive; wait for readiness or fail with
        // a host-busy error so concurrent projects cannot split the listener.
        const ready = await waitForHostReady(
          hostManifest,
          options.healthTimeoutMs,
          options.startupTimeoutMs,
        );
        if (ready) return attachWorkspaceStatus(ready, hostManifest.hostId, workspace);
        throw new DaemonHostBusyError(
          "A RouterMCP daemon host is running but is not ready for another workspace",
        );
      }

      // The host manifest is durable and may outlive a crashed daemon. Lease
      // counts belong to that process, so clear them only after the recorded
      // process identity has been proven dead before starting its replacement.
      if (!(await matchesProcessIdentity(hostManifest.processIdentity))) {
        await registry.resetActiveConnections();
      }
      await removeDaemonHostManifest(hostPaths.runtimeManifest);
    }

    const status = await ensureRunning(profilePaths, {
      ...options,
      projectPath: descriptor.directory,
      configFingerprint: descriptor.configDigest,
    });
    if (!status.running || !status.pid || !status.manifest) {
      throw new Error(status.reason ?? "RouterMCP daemon did not become ready");
    }

    const hostManifestForWorkspace = await createDaemonHostManifest({
      hostId: hostPaths.hostId,
      instanceId: status.instanceId,
      pid: status.pid,
      processIdentity: status.manifest.processIdentity,
      cliVersion: status.cliVersion,
      protocolVersion: status.protocolVersion,
      host: status.host,
      port: status.port,
      socketPath: status.socket,
      mcpUrl: status.mcpUrl,
      controlUrl: status.controlUrl,
      state: "ready",
      primaryProjectPath: descriptor.directory,
      primaryConfigPath: descriptor.configPath,
      primaryProfileId: descriptor.profileId,
      primaryConfigFingerprint: descriptor.configDigest,
      localAuthToken: status.authToken,
    });
    await writeDaemonHostManifest(hostPaths.runtimeManifest, hostManifestForWorkspace);

    return attachWorkspaceStatus(status, hostPaths.hostId, workspace);
  } finally {
    await lock.release();
  }
}

/**
 * Read status through the host when possible. Unknown/stale host state falls
 * back to the profile lifecycle so existing CLI commands remain useful during
 * migration.
 */
export async function getWorkspaceDaemonStatus(
  input: WorkspaceRegistrationInput,
  options: { registry?: WorkspaceRegistry; healthTimeoutMs?: number } = {},
): Promise<WorkspaceDaemonStatus | DaemonStatus> {
  const registry = options.registry ?? new WorkspaceRegistry();
  const descriptor = await registry.describe(input);
  await registry.load();
  const hostPaths = getDaemonHostPaths();
  const hostManifest = await readDaemonHostManifest(hostPaths.runtimeManifest);
  if (hostManifest) {
    const status = await getHostDaemonStatus(hostManifest, options.healthTimeoutMs);
    if (status.running) {
      const workspace = await registry.get(descriptor.id);
      return attachWorkspaceStatus(
        status,
        hostManifest.hostId,
        workspace ?? makeUnregisteredWorkspace(descriptor),
      );
    }
  }

  const profilePaths = getDaemonPaths(
    getProjectId(descriptor.directory),
    descriptor.configPath,
    descriptor.directory,
  );
  return getDaemonStatus(profilePaths, {
    configFingerprint: descriptor.configDigest,
    healthTimeoutMs: options.healthTimeoutMs,
  });
}

/**
 * Probe the user-scoped host without applying a profile/config compatibility
 * check. A host owns the listener and process identity; individual config
 * fingerprints are selected by the runtime manager after a bridge lease is
 * acquired. Keeping this probe separate from getDaemonStatus is what allows a
 * second project to reuse the first project's process safely.
 */
async function getHostDaemonStatus(
  manifest: DaemonHostManifest,
  healthTimeoutMs = 1_000,
): Promise<DaemonStatus> {
  const baseStatus: DaemonStatus = {
    running: false,
    state: manifest.state,
    pid: manifest.pid,
    port: manifest.port,
    host: manifest.host,
    socket: manifest.socketPath,
    profileId: manifest.primaryProfileId,
    instanceId: manifest.instanceId,
    cliVersion: manifest.cliVersion,
    protocolVersion: manifest.protocolVersion,
    configPath: manifest.primaryConfigPath,
    configFingerprint: manifest.primaryConfigFingerprint,
    hostId: manifest.hostId,
    ...(manifest.mcpUrl ? { mcpUrl: manifest.mcpUrl } : {}),
    ...(manifest.controlUrl ? { controlUrl: manifest.controlUrl } : {}),
    ...(manifest.localAuthToken ? { authToken: manifest.localAuthToken } : {}),
  };

  if (manifest.state !== "ready") {
    return { ...baseStatus, reason: `Daemon host is ${manifest.state}` };
  }
  const compatibility = getDaemonHostCompatibility(manifest);
  if (!compatibility.compatible) {
    return { ...baseStatus, reason: compatibility.reason };
  }
  if (!(await matchesProcessIdentity(manifest.processIdentity))) {
    return { ...baseStatus, reason: "Daemon host process is no longer running" };
  }
  if (!manifest.localAuthToken || !manifest.port || !isLoopbackHost(manifest.host)) {
    return { ...baseStatus, reason: "Daemon host manifest has no valid authenticated endpoint" };
  }

  const health = await probeHostHealth(manifest, healthTimeoutMs);
  if (!health) {
    return { ...baseStatus, reason: "Authenticated daemon host health check failed" };
  }

  if (
    (health.instanceId !== undefined && health.instanceId !== manifest.instanceId) ||
    (health.pid !== undefined && health.pid !== manifest.pid) ||
    (health.state !== undefined && health.state !== "ready") ||
    (health.cliVersion !== undefined && health.cliVersion !== manifest.cliVersion) ||
    (health.protocolVersion !== undefined && health.protocolVersion !== manifest.protocolVersion) ||
    (health.host !== undefined && health.host !== manifest.host) ||
    (health.port !== undefined && health.port !== manifest.port)
  ) {
    return { ...baseStatus, reason: "Daemon host health descriptor did not match manifest" };
  }

  if (
    health.hostProtocolVersion !== manifest.hostProtocolVersion ||
    health.hostCapabilityVersion !== manifest.hostCapabilityVersion ||
    !hasDaemonHostCapabilities(
      asStringArray(health.hostCapabilities),
      manifest.hostCapabilities ?? [],
    )
  ) {
    return { ...baseStatus, reason: "Daemon host capabilities did not match manifest" };
  }

  return { ...baseStatus, running: true };
}

async function waitForHostReady(
  manifest: DaemonHostManifest,
  healthTimeoutMs = 1_000,
  startupTimeoutMs = 15_000,
): Promise<DaemonStatus | null> {
  const deadline = Date.now() + Math.max(healthTimeoutMs, startupTimeoutMs);
  while (Date.now() < deadline) {
    const status = await getHostDaemonStatus(manifest, healthTimeoutMs);
    if (status.running) return status;
    if (!(await matchesProcessIdentity(manifest.processIdentity))) return null;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return null;
}

async function probeHostHealth(
  manifest: DaemonHostManifest,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  let url: URL;
  try {
    const endpoint = manifest.controlUrl ?? `http://${formatHost(manifest.host)}:${manifest.port}`;
    url = new URL(DAEMON_HEALTH_PATH, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) return null;
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${manifest.localAuthToken}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Stop a host only when no other workspace has an active bridge. */
export async function stopWorkspaceDaemon(
  input: WorkspaceRegistrationInput,
  options: StopDaemonOptions & { registry?: WorkspaceRegistry; allowActiveWorkspaces?: boolean } = {},
): Promise<void> {
  const registry = options.registry ?? new WorkspaceRegistry();
  const descriptor = await registry.describe(input);
  await registry.load();
  const hostPaths = getDaemonHostPaths();
  const lock = await acquireProfileLock(hostPaths.lock, { timeoutMs: options.lockTimeoutMs });

  try {
    const hostManifest = await readDaemonHostManifest(hostPaths.runtimeManifest);
    // Ownership is based on the canonical config path. The digest can be
    // newer than the host manifest while a config mutation is waiting for its
    // controlled restart, but the same host still owns the profile and must
    // be stopped by a request from any attached workspace.
    // A controlled restart can temporarily fail the health probe while the
    // process identity remains live. It still owns the shared listener, so
    // stop it through its primary profile lifecycle rather than falling back
    // to a second profile and risking an unrelated process.
    if (hostManifest && (await matchesProcessIdentity(hostManifest.processIdentity))) {
      const activeOther = registry
        .listSync()
        .some((workspace) => workspace.id !== descriptor.id && workspace.activeConnections > 0);
      if (activeOther && options.allowActiveWorkspaces !== true) {
        throw new DaemonHostBusyError(
          "The RouterMCP daemon host still has active connections from another workspace",
        );
      }

      const primaryPaths = getPrimaryProfilePaths(hostManifest);
      if (primaryPaths) {
        await stopDaemon(primaryPaths, options);
      }
      await removeDaemonHostManifest(hostPaths.runtimeManifest);
      return;
    }

    const profilePaths = getDaemonPaths(
      getProjectId(descriptor.directory),
      descriptor.configPath,
      descriptor.directory,
    );
    await stopDaemon(profilePaths, options);
  } finally {
    await lock.release();
  }
}

/** Restart the owning host and preserve the workspace conflict guard. */
export async function restartWorkspaceDaemon(
  input: WorkspaceRegistrationInput,
  options: EnsureWorkspaceDaemonOptions = {},
): Promise<WorkspaceDaemonStatus> {
  const registry = options.registry ?? new WorkspaceRegistry();
  await stopWorkspaceDaemon(input, {
    ...options,
    registry,
    // A controlled configuration/mode restart is allowed to replace the
    // shared process. Existing bridges observe the restart and reconnect;
    // explicit user `stop` keeps the safety guard above.
    allowActiveWorkspaces: true,
  });
  return ensureWorkspaceRunning(input, {
    ...options,
    registry,
  });
}

function getPrimaryProfilePaths(
  manifest: DaemonHostManifest,
) {
  if (!manifest.primaryProjectPath || !manifest.primaryConfigPath) return null;
  return getDaemonPaths(
    getProjectId(manifest.primaryProjectPath),
    manifest.primaryConfigPath,
    manifest.primaryProjectPath,
  );
}

function attachWorkspaceStatus(
  status: DaemonStatus,
  hostId: string,
  workspace: WorkspaceSnapshot,
): WorkspaceDaemonStatus {
  return {
    ...status,
    hostId,
    workspaceId: workspace.id,
    projectPath: workspace.directory,
  };
}

function makeUnregisteredWorkspace(descriptor: {
  id: string;
  directory: string;
  configPath: string;
  configScope: WorkspaceRegistrationInput["configScope"];
  profileId: string;
  configDigest: string;
}): WorkspaceSnapshot {
  const timestamp = new Date().toISOString();
  return {
    ...descriptor,
    state: "current",
    activeConnections: 0,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
