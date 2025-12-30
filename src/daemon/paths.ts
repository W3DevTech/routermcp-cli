import { resolve } from "node:path";
import { getDaemonDir } from "./project.js";

export interface DaemonPaths {
  dir: string;
  socket: string;
  port: string;
  pid: string;
  log: string;
  configPath: string;
}

export function getDaemonPaths(projectId: string, configPath: string): DaemonPaths {
  const dir = getDaemonDir(projectId);
  return {
    dir,
    socket: resolve(dir, "daemon.sock"),
    port: resolve(dir, "daemon.port"),
    pid: resolve(dir, "daemon.pid"),
    log: resolve(dir, "daemon.log"),
    configPath,
  };
}

export function isWindows(): boolean {
  return process.platform === "win32";
}
