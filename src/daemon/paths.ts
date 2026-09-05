import { resolve } from "node:path";
import { getProfileDir, getProfileId } from "./project.js";

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
