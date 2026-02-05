import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Generate a unique project ID from a directory path.
 * Normalizes the path and replaces path separators with dashes.
 */
export function getProjectId(cwd: string = process.cwd()): string {
  const normalized = resolve(cwd);
  return normalized.replace(/^\//, "").replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "");
}

/**
 * Get the legacy RouterMCP directory used by older versions.
 * Historically stored state/config at ~/.routermcp.
 */
export function getLegacyRouterMcpDir(): string {
  return resolve(homedir(), ".routermcp");
}

/**
 * Get the RouterMCP configuration directory.
 * Uses ~/.config/routermcp following XDG conventions.
 */
export function getRouterMcpDir(): string {
  return resolve(homedir(), ".config", "routermcp");
}

/**
 * Get the projects directory for daemon and user-scoped project configs.
 */
export function getProjectsDir(): string {
  return resolve(getRouterMcpDir(), "projects");
}

/**
 * Get the daemon directory for a specific project.
 */
export function getDaemonDir(projectId: string): string {
  return resolve(getProjectsDir(), projectId);
}

/**
 * Get the user-global config file path.
 * Located at ~/.config/routermcp/routermcp.jsonc
 */
export function getUserGlobalConfigPath(): string {
  return resolve(getRouterMcpDir(), "routermcp.jsonc");
}

/**
 * Get the user-scoped project config file path.
 * Located at ~/.config/routermcp/projects/<projectId>/routermcp.jsonc
 */
export function getUserProjectConfigPath(projectId: string): string {
  return resolve(getProjectsDir(), projectId, "routermcp.jsonc");
}
