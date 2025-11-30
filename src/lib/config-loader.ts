import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { RouterMcpConfig } from "../types.ts";

const CONFIG_FILENAMES = ["routermcp.jsonc", "routermcp.json"];

/**
 * Find the configuration file in the project root
 * @param cwd Working directory to search in
 * @returns Path to the config file if found, null otherwise
 */
export function findConfigFile(cwd: string = process.cwd()): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const filepath = join(cwd, filename);
    if (existsSync(filepath)) {
      return filepath;
    }
  }
  return null;
}

/**
 * Load and parse the configuration file
 * @param filepath Path to the configuration file
 * @returns Parsed configuration object
 */
export function loadConfig(filepath: string): RouterMcpConfig {
  const content = readFileSync(filepath, "utf-8");
  const errors: ParseError[] = [];
  const config = parseJsonc(content, errors) as RouterMcpConfig;

  if (errors.length > 0) {
    throw new Error(
      `Failed to parse config file: ${errors.map((e) => e.error).join(", ")}`
    );
  }

  // Validate the config structure
  if (!config || typeof config !== "object") {
    throw new Error("Invalid config: expected an object");
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    throw new Error('Invalid config: "mcpServers" must be an object');
  }

  return config;
}

/**
 * Save configuration to a file
 * @param filepath Path to save the configuration
 * @param config Configuration object
 */
export function saveConfig(filepath: string, config: RouterMcpConfig): void {
  const content = JSON.stringify(config, null, 2);
  writeFileSync(filepath, content, "utf-8");
}

/**
 * Get the default config file path
 * @param cwd Working directory
 * @returns Path to routermcp.json
 */
export function getDefaultConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, "routermcp.json");
}

/**
 * Create a default empty configuration
 */
export function createDefaultConfig(): RouterMcpConfig {
  return {
    mcpServers: {},
  };
}
