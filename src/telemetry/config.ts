import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { file, write } from "../compat/index.js";
import { getLegacyRouterMcpDir, getRouterMcpDir } from "../daemon/project.js";
import type { TelemetryConfig, UserConfig } from "./types.js";

const ROUTERMCP_DIR = getRouterMcpDir();
const LEGACY_ROUTERMCP_DIR = getLegacyRouterMcpDir();
const CONFIG_PATH = join(ROUTERMCP_DIR, "config.json");
const LEGACY_CONFIG_PATH = join(LEGACY_ROUTERMCP_DIR, "config.json");

const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
};

export async function loadUserConfig(): Promise<UserConfig> {
  const f = file(CONFIG_PATH);

  if (!(await f.exists())) {
    // Back-compat: read legacy ~/.routermcp/config.json if present.
    const legacy = file(LEGACY_CONFIG_PATH);
    if (await legacy.exists()) {
      try {
        const text = await legacy.text();
        return JSON.parse(text) as UserConfig;
      } catch {
        return {};
      }
    }

    return {};
  }

  try {
    const text = await f.text();
    return JSON.parse(text) as UserConfig;
  } catch {
    return {};
  }
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  await mkdir(ROUTERMCP_DIR, { recursive: true });
  await write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** The DO_NOT_TRACK convention (https://consoledonottrack.com) always opts out. */
function isDoNotTrackSet(): boolean {
  const value = process.env.DO_NOT_TRACK?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export async function isTelemetryEnabled(): Promise<boolean> {
  if (isDoNotTrackSet()) return false;
  const config = await loadUserConfig();
  return config.telemetry?.enabled ?? DEFAULT_TELEMETRY_CONFIG.enabled;
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  const config = await loadUserConfig();
  config.telemetry = { ...config.telemetry, enabled };
  await saveUserConfig(config);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
