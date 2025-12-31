import { homedir } from "node:os";
import { resolve } from "node:path";

export function getProjectId(cwd: string = process.cwd()): string {
  const normalized = resolve(cwd);
  return normalized.replace(/^\//, "").replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "");
}

export function getRouterMcpDir(): string {
  return resolve(homedir(), ".routermcp");
}

export function getProjectsDir(): string {
  return resolve(getRouterMcpDir(), "projects");
}

export function getDaemonDir(projectId: string): string {
  return resolve(getProjectsDir(), projectId);
}
