/**
 * JSONC configuration file discovery and parsing
 */

import { existsSync, readFileSync } from "fs";
import { parse as parseJsonc, ParseError, printParseErrorCode } from "jsonc-parser";
import { routerMcpConfigSchema } from "./schema.js";
import type { RouterMcpConfig } from "./types.js";
import { ConfigError } from "../utils/errors.js";

/**
 * Default config file names to search for
 */
const CONFIG_FILE_NAMES = [
  "routermcp.jsonc",
  "routermcp.json",
  ".routermcp.jsonc",
  ".routermcp.json",
];

export interface LoadConfigResult {
  config: RouterMcpConfig;
  warnings: string[];
}

/**
 * Discovers and loads the RouterMCP configuration file
 *
 * @param configPath Optional explicit path to config file
 * @returns Parsed and validated configuration
 */
export async function loadConfig(configPath?: string): Promise<RouterMcpConfig> {
  const filePath = configPath ?? discoverConfigFile();

  if (!filePath) {
    throw new ConfigError(
      `No configuration file found. Searched for: ${CONFIG_FILE_NAMES.join(", ")}`,
    );
  }

  const content = readConfigFile(filePath);
  const parsed = parseJsoncContent(content, filePath);
  const warnings: string[] = [];
  const expanded = expandEnvVars(parsed, warnings);
  
  // Log any environment variable warnings
  for (const warning of warnings) {
    console.warn(`[config] ${warning}`);
  }
  
  const validated = validateConfig(expanded, filePath);

  return validated;
}

/**
 * Searches for a config file in the current directory
 */
function discoverConfigFile(): string | undefined {
  for (const fileName of CONFIG_FILE_NAMES) {
    if (existsSync(fileName)) {
      return fileName;
    }
  }
  return undefined;
}

/**
 * Reads config file content
 */
function readConfigFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new ConfigError(`Configuration file not found: ${filePath}`);
  }

  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new ConfigError(
      `Failed to read configuration file: ${filePath}`,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Parses JSONC content with error handling
 */
function parseJsoncContent(content: string, filePath: string): unknown {
  const errors: ParseError[] = [];
  const result = parseJsonc(content, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const errorMessages = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join("; ");
    throw new ConfigError(`Failed to parse ${filePath}: ${errorMessages}`);
  }

  return result;
}

/**
 * Recursively expands environment variables in strings using ${VAR} syntax.
 * Logs a warning when an environment variable is referenced but not defined.
 * 
 * @param obj Object to expand
 * @param warnings Array to collect warning messages
 * @returns Expanded object with environment variables substituted
 */
function expandEnvVars(obj: unknown, warnings: string[] = []): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        // Log warning for undefined env vars but continue with empty string
        // This is intentional as the variable may be optional
        warnings.push(`Environment variable '${varName}' is not defined, using empty string`);
        return "";
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVars(item, warnings));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value, warnings);
    }
    return result;
  }

  return obj;
}

/**
 * Validates config against schema
 */
function validateConfig(config: unknown, filePath: string): RouterMcpConfig {
  const result = routerMcpConfigSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  ");
    throw new ConfigError(`Invalid configuration in ${filePath}:\n  ${issues}`);
  }

  return result.data as RouterMcpConfig;
}

export { CONFIG_FILE_NAMES };
