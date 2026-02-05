import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { file, write } from "../compat/index.js";
import { getLegacyRouterMcpDir, getRouterMcpDir } from "../daemon/project.js";

const ROUTERMCP_DIR = getRouterMcpDir();
const LEGACY_ROUTERMCP_DIR = getLegacyRouterMcpDir();
const CREDENTIALS_FILE = join(ROUTERMCP_DIR, "credentials.json");
const LEGACY_CREDENTIALS_FILE = join(LEGACY_ROUTERMCP_DIR, "credentials.json");

/**
 * Credentials stored in ~/.config/routermcp/credentials.json
 */
export interface Credentials {
  ngrok?: {
    authToken: string;
  };
  routermcpCloud?: {
    apiKey: string;
  };
}

/**
 * Ensure the ~/.config/routermcp directory exists.
 */
export async function ensureCredentialsDir(): Promise<void> {
  try {
    await mkdir(ROUTERMCP_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

/**
 * Load credentials from ~/.config/routermcp/credentials.json
 */
export async function loadCredentials(): Promise<Credentials> {
  const f = file(CREDENTIALS_FILE);
  if (!(await f.exists())) {
    // Back-compat: read legacy ~/.routermcp/credentials.json if present.
    const legacy = file(LEGACY_CREDENTIALS_FILE);
    if (await legacy.exists()) {
      try {
        const text = await legacy.text();
        return JSON.parse(text) as Credentials;
      } catch {
        return {};
      }
    }

    return {};
  }
  try {
    const text = await f.text();
    return JSON.parse(text) as Credentials;
  } catch {
    return {};
  }
}

/**
 * Save credentials to ~/.config/routermcp/credentials.json
 */
export async function saveCredentials(credentials: Credentials): Promise<void> {
  await ensureCredentialsDir();
  await write(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
}

/**
 * Get the ngrok auth token from credentials.
 */
export async function getNgrokToken(): Promise<string | null> {
  const creds = await loadCredentials();
  return creds.ngrok?.authToken ?? null;
}

/**
 * Save the ngrok auth token to credentials.
 */
export async function setNgrokToken(token: string): Promise<void> {
  const creds = await loadCredentials();
  creds.ngrok = { authToken: token };
  await saveCredentials(creds);
}

/**
 * Get the RouterMCP Cloud API key from credentials.
 */
export async function getRoutermcpCloudApiKey(): Promise<string | null> {
  const creds = await loadCredentials();
  return creds.routermcpCloud?.apiKey ?? null;
}

/**
 * Save the RouterMCP Cloud API key to credentials.
 */
export async function setRoutermcpCloudApiKey(apiKey: string): Promise<void> {
  const creds = await loadCredentials();
  creds.routermcpCloud = { apiKey };
  await saveCredentials(creds);
}

/**
 * Get the path to the credentials file.
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}
