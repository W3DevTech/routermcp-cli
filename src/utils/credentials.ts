import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { file, write } from "../compat/index.js";

const ROUTERMCP_DIR = join(homedir(), ".routermcp");
const CREDENTIALS_FILE = join(ROUTERMCP_DIR, "credentials.json");

/**
 * Credentials stored in ~/.routermcp/credentials.json
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
 * Ensure the ~/.routermcp directory exists.
 */
export async function ensureCredentialsDir(): Promise<void> {
  try {
    await mkdir(ROUTERMCP_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

/**
 * Load credentials from ~/.routermcp/credentials.json
 */
export async function loadCredentials(): Promise<Credentials> {
  const f = file(CREDENTIALS_FILE);
  if (!(await f.exists())) {
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
 * Save credentials to ~/.routermcp/credentials.json
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
