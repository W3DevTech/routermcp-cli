import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { file, write } from "../compat/index.js";
import type { TelemetryConfig, UserConfig } from "./types.js";

const ROUTERMCP_DIR = join(homedir(), ".routermcp");
const CONFIG_PATH = join(ROUTERMCP_DIR, "config.json");

const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
};

export async function loadUserConfig(): Promise<UserConfig> {
  const f = file(CONFIG_PATH);

  if (!(await f.exists())) {
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

export async function isTelemetryEnabled(): Promise<boolean> {
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
