import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import { RouterMcpConfigSchema } from "./schema.js";
import { ConfigError } from "../utils/errors.js";
import { file } from "../compat/index.js";
import type { RouterMcpConfig } from "./types.js";

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
      err instanceof Error ? err : undefined
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
      err instanceof Error ? err : undefined
    );
  }

  if (errors.length > 0) {
    const errorMessages = errors.map(
      (e) => `Parse error at offset ${e.offset}: error code ${e.error}`
    );
    throw new ConfigError(
      `Invalid JSON in config file ${path}:\n${errorMessages.join("\n")}`
    );
  }

  // Normalize config for backwards compatibility
  const normalized = normalizeConfig(parsed);

  // Expand environment variables in the config
  const expanded = expandEnvVars(normalized);

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

  for (const serverConfig of Object.values(
    mcpServers as Record<string, unknown>
  )) {
    if (!serverConfig || typeof serverConfig !== "object") continue;

    const server = serverConfig as Record<string, unknown>;

    // Map "type" to "transport" (Claude Code uses "type")
    if ("type" in server && !("transport" in server)) {
      server.transport = server.type;
      delete server.type;
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

/**
 * Recursively expand environment variables in strings.
 * Supports ${VAR_NAME} syntax.
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] ?? "";
    });
  }

  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = expandEnvVars(val);
    }
    return result;
  }

  return value;
}

/**
 * Load config from default location or specified path.
 */
export async function loadConfigFromPath(
  configPath?: string
): Promise<{ config: RouterMcpConfig; path: string }> {
  let path: string;

  if (configPath) {
    path = configPath;
  } else {
    const found = await findConfigFile(process.cwd());
    if (!found) {
      throw new ConfigError(
        `No config file found. Create routermcp.jsonc or specify --config path.`
      );
    }
    path = found;
  }

  const config = await loadConfig(path);
  return { config, path };
}
