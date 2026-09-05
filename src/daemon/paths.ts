import { resolve } from "node:path";
import { getDaemonHostDir, getDaemonHostId, getProfileDir, getProfileId } from "./project.js";

export interface DaemonPaths {
  dir: string;
  /** Project directory used when launching the daemon process. */
  projectPath: string;
  /** Stable profile identifier used to isolate runtime state. */
  profileId: string;
  /** Canonical atomic runtime manifest path. */
  runtimeManifest: string;
  /** Per-profile startup lock path. */
  lock: string;
  socket: string;
  port: string;
  pid: string;
  log: string;
  configPath: string;
}

/**
 * Paths owned by the user-scoped daemon host.
 *
 * Existing DaemonPaths remain profile-scoped for backwards compatibility. A
 * host path set is additive so callers can migrate lifecycle ownership in a
 * later stack without changing the on-disk contract of existing profiles.
 */
export interface DaemonHostPaths {
  dir: string;
  hostId: string;
  runtimeManifest: string;
  lock: string;
  socket: string;
  port: string;
  pid: string;
  log: string;
  workspaceRegistry: string;
}

export function getDaemonHostPaths(): DaemonHostPaths {
  const dir = getDaemonHostDir();
  return {
    dir,
    hostId: getDaemonHostId(),
    runtimeManifest: resolve(dir, "runtime.json"),
    lock: resolve(dir, "daemon.lock"),
    socket: resolve(dir, "daemon.sock"),
    port: resolve(dir, "daemon.port"),
    pid: resolve(dir, "daemon.pid"),
    log: resolve(dir, "daemon.log"),
    workspaceRegistry: resolve(dir, "workspaces.json"),
  };
}

export function getDaemonPaths(
  projectId: string,
  configPath: string,
  projectPath: string = process.cwd(),
): DaemonPaths {
  const profileId = getProfileId(projectId, configPath);
  const dir = getProfileDir(projectId, configPath);
  const runtimeManifest = resolve(dir, "runtime.json");
  return {
    dir,
    projectPath: resolve(projectPath),
    profileId,
    runtimeManifest,
    lock: resolve(dir, "daemon.lock"),
    socket: resolve(dir, "daemon.sock"),
    port: resolve(dir, "daemon.port"),
    pid: resolve(dir, "daemon.pid"),
    log: resolve(dir, "daemon.log"),
    configPath: resolve(configPath),
  };
}

export function isWindows(): boolean {
  return process.platform === "win32";
}
