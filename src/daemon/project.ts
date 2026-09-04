import { createHash } from "node:crypto";
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
 * Return a filesystem-safe, stable identifier for a resolved config profile.
 *
 * A project can have more than one RouterMCP config (for example, a local
 * config and an explicitly selected config file). The old daemon directory
 * was keyed only by project id, which made those profiles share pid/port
 * state. Including the normalized config path in this digest gives each
 * profile an independent runtime directory while keeping the path itself out
 * of the directory name.
 */
export function getProfileId(projectId: string, configPath: string): string {
  const normalizedConfigPath = resolve(configPath);
  const input = `${projectId}\u0000${normalizedConfigPath}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
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
 * Get the platform state directory used for daemon runtime metadata.
 *
 * Configuration remains under getRouterMcpDir(); runtime metadata is kept in
 * a state/application-data location so lock files, manifests, and logs do not
 * get mixed with user-edited configuration files.
 */
export function getRouterMcpRuntimeDir(): string {
  if (process.platform === "win32") {
    return resolve(
      process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"),
      "RouterMCP",
    );
  }

  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "RouterMCP");
  }

  return resolve(
    process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local", "state"),
    "routermcp",
  );
}

/**
 * Get the projects directory for daemon and user-scoped project configs.
 */
export function getProjectsDir(): string {
  return resolve(getRouterMcpDir(), "projects");
}

/** Get runtime metadata directories for all project profiles. */
export function getRuntimeProjectsDir(): string {
  return resolve(getRouterMcpRuntimeDir(), "projects");
}

/**
 * Get the daemon directory for a specific project.
 */
export function getDaemonDir(projectId: string, profileId?: string): string {
  if (profileId) {
    return resolve(getRuntimeProjectsDir(), projectId, "profiles", profileId);
  }

  // Keep the project root available for existing user-scoped configuration
  // and callers that only need the project directory. Runtime state is now
  // stored below the profile-specific directory returned by getProfileDir.
  return resolve(getRuntimeProjectsDir(), projectId);
}

/**
 * Get the runtime directory for one resolved project/config profile.
 */
export function getProfileDir(projectId: string, configPath: string): string {
  return getDaemonDir(projectId, getProfileId(projectId, configPath));
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
