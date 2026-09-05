import { resolve } from "node:path";
import { RouterMcpError } from "../utils/errors.js";
import {
  type DaemonStatus,
  ensureRunning,
  getDaemonStatus,
  type EnsureRunningOptions,
  type StopDaemonOptions,
  stopDaemon,
} from "./lifecycle.js";
import { acquireProfileLock } from "./lock.js";
import { getDaemonHostPaths, getDaemonPaths } from "./paths.js";
import { matchesProcessIdentity } from "./identity.js";
import { getProjectId } from "./project.js";
import {
  createDaemonHostManifest,
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
}

/**
 * Ensure a workspace is reachable through one user-scoped daemon host.
 *
 * The first workspace starts using the existing profile lifecycle. A later
 * workspace may reuse that host only when it resolves to the same config path
 * and digest. Different profiles receive an explicit conflict instead of
 * silently routing requests through another directory's configuration. This
 * is the safe bridge to fully isolated in-process contexts in a later stack.
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
      const compatible = hostManifestMatchesWorkspace(hostManifest, descriptor);
      if (!compatible) {
        if (await matchesProcessIdentity(hostManifest.processIdentity)) {
          const conflict = new DaemonHostProfileConflictError(
            "A RouterMCP daemon host is already serving another config profile; " +
              "stop it or use an isolated profile before connecting this workspace",
          );
          await registry.markUnavailable(workspace.id, conflict);
          throw conflict;
        }
        await removeDaemonHostManifest(hostPaths.runtimeManifest);
      } else {
        const primaryPaths = getPrimaryProfilePaths(hostManifest);
        if (primaryPaths) {
          const existing = await getDaemonStatus(primaryPaths, {
            configFingerprint: hostManifest.primaryConfigFingerprint,
            healthTimeoutMs: options.healthTimeoutMs,
          });
          if (existing.running) {
            return attachWorkspaceStatus(existing, hostManifest.hostId, workspace);
          }
        }
        await removeDaemonHostManifest(hostPaths.runtimeManifest);
      }
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
  if (hostManifest && hostManifestMatchesWorkspace(hostManifest, descriptor)) {
    const primaryPaths = getPrimaryProfilePaths(hostManifest);
    if (primaryPaths) {
      const status = await getDaemonStatus(primaryPaths, {
        configFingerprint: hostManifest.primaryConfigFingerprint,
        healthTimeoutMs: options.healthTimeoutMs,
      });
      if (status.running) {
        const workspace = await registry.get(descriptor.id);
        return attachWorkspaceStatus(
          status,
          hostManifest.hostId,
          workspace ?? makeUnregisteredWorkspace(descriptor),
        );
      }
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

/** Stop a host only when no other workspace has an active bridge. */
export async function stopWorkspaceDaemon(
  input: WorkspaceRegistrationInput,
  options: StopDaemonOptions & { registry?: WorkspaceRegistry } = {},
): Promise<void> {
  const registry = options.registry ?? new WorkspaceRegistry();
  const descriptor = await registry.describe(input);
  await registry.load();
  const hostPaths = getDaemonHostPaths();
  const lock = await acquireProfileLock(hostPaths.lock, { timeoutMs: options.lockTimeoutMs });

  try {
    const hostManifest = await readDaemonHostManifest(hostPaths.runtimeManifest);
    if (hostManifest && hostManifestMatchesWorkspace(hostManifest, descriptor)) {
      const activeOther = registry
        .listSync()
        .some((workspace) => workspace.id !== descriptor.id && workspace.activeConnections > 0);
      if (activeOther) {
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
  });
  return ensureWorkspaceRunning(input, {
    ...options,
    registry,
  });
}

function hostManifestMatchesWorkspace(
  manifest: DaemonHostManifest,
  workspace: { configPath: string; configDigest: string },
): boolean {
  return (
    manifest.state === "ready" &&
    !!manifest.primaryConfigPath &&
    resolve(manifest.primaryConfigPath) === resolve(workspace.configPath) &&
    manifest.primaryConfigFingerprint === workspace.configDigest
  );
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
