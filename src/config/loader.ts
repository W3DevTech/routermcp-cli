import { mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import { file } from "../compat/index.js";
import {
  getLegacyRouterMcpDir,
  getProjectId,
  getRouterMcpDir,
  getUserGlobalConfigPath,
  getUserProjectConfigPath,
} from "../daemon/project.js";
import { ConfigError } from "../utils/errors.js";
import { RouterMcpConfigSchema } from "./schema.js";
import type { ConfigLocation, ConfigScope, ResolvedConfig, RouterMcpConfig } from "./types.js";

/**
 * Default config file names to search for.
 */
const CONFIG_FILE_NAMES = ["routermcp.jsonc", "routermcp.json"];

/**
 * Find the config file path.
 * Searches in the specified directory for routermcp.jsonc or routermcp.json.
 */
export async function findConfigFile(dir: string): Promise<string | null> {
  for (const name of CONFIG_FILE_NAMES) {
    const path = `${dir}/${name}`;
    const f = file(path);
    if (await f.exists()) {
      return path;
    }
  }
  return null;
}

/**
 * Load and validate configuration from a file path.
 */
export async function loadConfig(path: string): Promise<RouterMcpConfig> {
  const f = file(path);

  if (!(await f.exists())) {
    throw new ConfigError(`Config file not found: ${path}`);
  }

  let content: string;
  try {
    content = await f.text();
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file: ${path}`,
      err instanceof Error ? err : undefined,
    );
  }

  // Parse JSONC (handles comments and trailing commas)
  let parsed: unknown;
  const errors: { error: number; offset: number; length: number }[] = [];

  try {
    parsed = parseJsonc(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
  } catch (err) {
    throw new ConfigError(
      `Failed to parse config file: ${path}`,
      err instanceof Error ? err : undefined,
    );
  }

  if (errors.length > 0) {
    const errorMessages = errors.map(
      (e) => `Parse error at offset ${e.offset}: error code ${e.error}`,
    );
    throw new ConfigError(`Invalid JSON in config file ${path}:\n${errorMessages.join("\n")}`);
  }

  // Normalize config for backwards compatibility
  const normalized = normalizeConfig(parsed);

  // Extract strictEnvVars before expansion (it's not subject to expansion itself)
  const normalizedObj = normalized as Record<string, unknown> | null;
  const strictEnvVars = normalizedObj?.strictEnvVars === true;

  // Expand environment variables in the config
  const expanded = expandEnvVars(normalized, { strict: strictEnvVars });

  // Validate with Zod schema
  const result = RouterMcpConfigSchema.safeParse(expanded);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration in ${path}:\n${issues}`);
  }

  return result.data as RouterMcpConfig;
}

/**
 * Normalize config for backwards compatibility and auto-detection.
 * - Maps "type" field to "transport" (Claude Code compatibility)
 * - Maps "http" to "http-streamable"
 * - Auto-detects transport from "command" or "url" keys
 */
function normalizeConfig(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;

  const config = parsed as Record<string, unknown>;
  const mcpServers = config.mcpServers;

  if (!mcpServers || typeof mcpServers !== "object") return parsed;

  for (const serverConfig of Object.values(mcpServers as Record<string, unknown>)) {
    if (!serverConfig || typeof serverConfig !== "object") continue;

    const server = serverConfig as Record<string, unknown>;

    // Map "type" to "transport" (Claude Code uses "type")
    if ("type" in server && !("transport" in server)) {
      server.transport = server.type;
      server.type = undefined;
    }

    // Map "http" to "http-streamable"
    if (server.transport === "http") {
      server.transport = "http-streamable";
    }

    // Auto-detect transport from keys if not specified
    if (!("transport" in server)) {
      if ("command" in server) {
        server.transport = "stdio";
      } else if ("url" in server) {
        server.transport = "http-streamable";
      }
    }
  }

  return parsed;
}

interface EnvExpansionOptions {
  strict: boolean;
}

interface EnvReference {
  varName: string;
  defaultValue: string | undefined;
  isNewSyntax: boolean;
}

// Pattern: env:VAR_NAME or env:VAR_NAME:-default
const NEW_SYNTAX_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/;
// Pattern: VAR_NAME (legacy)
const LEGACY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)$/;

function parseEnvReference(content: string): EnvReference | null {
  const trimmed = content.trim();

  const newMatch = trimmed.match(NEW_SYNTAX_PATTERN);
  if (newMatch) {
    return {
      varName: newMatch[1],
      defaultValue: newMatch[2],
      isNewSyntax: true,
    };
  }

  const legacyMatch = trimmed.match(LEGACY_PATTERN);
  if (legacyMatch) {
    return {
      varName: legacyMatch[1],
      defaultValue: undefined,
      isNewSyntax: false,
    };
  }

  return null;
}

function expandEnvReference(match: string, content: string, options: EnvExpansionOptions): string {
  const parsed = parseEnvReference(content);

  if (!parsed) {
    return match;
  }

  const { varName, defaultValue, isNewSyntax } = parsed;
  const envValue = process.env[varName];

  if (envValue !== undefined) {
    return envValue;
  }

  if (defaultValue !== undefined) {
    return defaultValue;
  }

  if (isNewSyntax) {
    if (options.strict) {
      throw new ConfigError(`Environment variable not found: ${varName}`);
    }
    console.error(`[config] Environment variable not found: ${varName}`);
    return match;
  }

  // Legacy syntax: emit deprecation warning and return empty string
  console.error(
    `[config] Deprecation: \${${varName}} syntax is deprecated. Use \${env:${varName}} instead.`,
  );
  return "";
}

function expandEnvVars(value: unknown, options: EnvExpansionOptions): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, content) => {
      return expandEnvReference(match, content, options);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVars(item, options));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = expandEnvVars(val, options);
    }
    return result;
  }

  return value;
}

/**
 * Load config from default location or specified path.
 * @deprecated Use resolveConfigFromPath for multi-scope support
 */
export async function loadConfigFromPath(
  configPath?: string,
): Promise<{ config: RouterMcpConfig; path: string }> {
  let path: string;

  if (configPath) {
    path = configPath;
  } else {
    const found = await findConfigFile(process.cwd());
    if (!found) {
      throw new ConfigError(
        "No config file found. Create routermcp.jsonc or specify --config path.",
      );
    }
    path = found;
  }

  const config = await loadConfig(path);
  return { config, path };
}

/**
 * Get human-readable label for a config scope.
 */
export function getScopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "project-local":
      return "Project-local";
    case "user-project":
      return "User-scoped project";
    case "user-global":
      return "User global";
  }
}

/**
 * Get the config path for a specific scope.
 */
export function getConfigPathForScope(scope: ConfigScope, cwd: string = process.cwd()): string {
  switch (scope) {
    case "project-local":
      return `${cwd}/routermcp.jsonc`;
    case "user-project":
      return getUserProjectConfigPath(getProjectId(cwd));
    case "user-global":
      return getUserGlobalConfigPath();
  }
}

/**
 * Check if a config file exists at the given path (supports both .jsonc and .json).
 */
async function checkConfigExists(basePath: string): Promise<string | null> {
  // If path ends with .jsonc, also check .json variant
  if (basePath.endsWith(".jsonc")) {
    if (await file(basePath).exists()) {
      return basePath;
    }
    const jsonPath = basePath.replace(/\.jsonc$/, ".json");
    if (await file(jsonPath).exists()) {
      return jsonPath;
    }
    return null;
  }

  // If path ends with .json, also check .jsonc variant
  if (basePath.endsWith(".json")) {
    if (await file(basePath).exists()) {
      return basePath;
    }
    const jsoncPath = basePath.replace(/\.json$/, ".jsonc");
    if (await file(jsoncPath).exists()) {
      return jsoncPath;
    }
    return null;
  }

  // Otherwise just check as-is
  if (await file(basePath).exists()) {
    return basePath;
  }
  return null;
}

/**
 * Get all config locations with existence status, ordered by priority.
 * Priority: project-local (1) > user-project (2) > user-global (3)
 */
export async function getConfigLocations(cwd: string = process.cwd()): Promise<ConfigLocation[]> {
  const projectId = getProjectId(cwd);

  // Define base paths for each scope
  const projectLocalBase = await findConfigFile(cwd);
  const userProjectBase = getUserProjectConfigPath(projectId);
  const userGlobalBase = getUserGlobalConfigPath();

  // Check existence for user-scoped configs (project-local already checked via findConfigFile)
  const userProjectPath = await checkConfigExists(userProjectBase);
  const userGlobalPath = await checkConfigExists(userGlobalBase);

  // Back-compat: look for legacy ~/.routermcp locations for user-scoped configs.
  // Only used if the new ~/.config/routermcp path doesn't exist.
  const legacyRouterDir = getLegacyRouterMcpDir();
  const legacyUserGlobalBase = resolvePath(legacyRouterDir, "routermcp.jsonc");
  const legacyUserProjectBase = resolvePath(legacyRouterDir, "projects", projectId, "routermcp.jsonc");

  const legacyUserProjectPath = userProjectPath ? null : await checkConfigExists(legacyUserProjectBase);
  const legacyUserGlobalPath = userGlobalPath ? null : await checkConfigExists(legacyUserGlobalBase);

  return [
    {
      scope: "project-local",
      path: projectLocalBase || `${cwd}/routermcp.jsonc`,
      exists: projectLocalBase !== null,
    },
    {
      scope: "user-project",
      path: userProjectPath || legacyUserProjectPath || userProjectBase,
      exists: userProjectPath !== null || legacyUserProjectPath !== null,
    },
    {
      scope: "user-global",
      path: userGlobalPath || legacyUserGlobalPath || userGlobalBase,
      exists: userGlobalPath !== null || legacyUserGlobalPath !== null,
    },
  ];
}

/**
 * Resolve config by priority - returns first existing config.
 * Priority: project-local (1) > user-project (2) > user-global (3)
 */
export async function resolveConfig(cwd: string = process.cwd()): Promise<ResolvedConfig | null> {
  const locations = await getConfigLocations(cwd);

  for (const loc of locations) {
    if (loc.exists) {
      const config = await loadConfig(loc.path);
      return { config, path: loc.path, scope: loc.scope };
    }
  }

  return null;
}

/**
 * Resolve config from path or by priority if no path specified.
 * When a specific path is provided, it's loaded directly.
 * Otherwise, configs are resolved by priority across all scopes.
 */
export async function resolveConfigFromPath(
  configPath?: string,
  cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
  // If explicit path provided, load it directly
  if (configPath) {
    const resolvedConfigPath = resolvePath(configPath);
    const config = await loadConfig(resolvedConfigPath);

    // Determine scope from path (normalize both sides to handle relative paths)
    const locations = await getConfigLocations(cwd);
    const matchingLoc = locations.find((loc) => resolvePath(loc.path) === resolvedConfigPath);

    return {
      config,
      path: resolvedConfigPath,
      scope: matchingLoc?.scope || "project-local",
    };
  }

  // Resolve by priority
  const resolved = await resolveConfig(cwd);
  if (!resolved) {
    throw new ConfigError(
      "No config file found. Create routermcp.jsonc or specify --config path.\n" +
        "Searched locations:\n" +
        "  - ./routermcp.jsonc (project-local)\n" +
        "  - ~/.config/routermcp/projects/<project>/routermcp.jsonc (user-project)\n" +
        "  - ~/.config/routermcp/routermcp.jsonc (user-global)",
    );
  }

  return resolved;
}

/**
 * Ensure the config directory exists for the given scope.
 * Creates parent directories as needed.
 */
export async function ensureConfigDir(
  scope: ConfigScope,
  cwd: string = process.cwd(),
): Promise<void> {
  const configPath = getConfigPathForScope(scope, cwd);
  const dir = dirname(configPath);
  await mkdir(dir, { recursive: true });
}
