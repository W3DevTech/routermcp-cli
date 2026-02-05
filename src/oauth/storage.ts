import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { file, write } from "../compat/index.js";
import { getLegacyRouterMcpDir, getRouterMcpDir } from "../daemon/project.js";

const ROUTERMCP_DIR = getRouterMcpDir();
const LEGACY_ROUTERMCP_DIR = getLegacyRouterMcpDir();
const OAUTH_DIR = join(ROUTERMCP_DIR, "mcp-oauth");
const LEGACY_OAUTH_DIR = join(LEGACY_ROUTERMCP_DIR, "mcp-oauth");

export interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

export interface OAuthTokensData {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
}

export interface OAuthStorageData {
  serverUrl: string;
  lastUpdated: number;
  clientInfo?: OAuthClientInfo;
  tokens?: OAuthTokensData;
  codeVerifier?: string;
}

export interface OAuthServerStatus {
  serverUrl: string;
  hostHash: string;
  hasTokens: boolean;
  hasClientInfo: boolean;
  expiresAt?: number;
  isExpired: boolean;
}

export function getServerHostHash(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    const host = url.host;
    const hash = createHash("sha256").update(host).digest("hex");
    return hash.substring(0, 8);
  } catch {
    const hash = createHash("sha256").update(serverUrl).digest("hex");
    return hash.substring(0, 8);
  }
}

export function getOAuthStorageDir(serverUrl: string): string {
  const hostHash = getServerHostHash(serverUrl);
  return join(OAUTH_DIR, hostHash);
}

function getLegacyOAuthStorageDir(serverUrl: string): string {
  const hostHash = getServerHostHash(serverUrl);
  return join(LEGACY_OAUTH_DIR, hostHash);
}

export function getOAuthStoragePath(serverUrl: string): string {
  return join(getOAuthStorageDir(serverUrl), "auth.json");
}

function getLegacyOAuthStoragePath(serverUrl: string): string {
  return join(getLegacyOAuthStorageDir(serverUrl), "auth.json");
}

async function ensureOAuthDir(serverUrl: string): Promise<void> {
  const dir = getOAuthStorageDir(serverUrl);
  await mkdir(dir, { recursive: true });
}

export async function loadOAuthStorage(serverUrl: string): Promise<OAuthStorageData | null> {
  const path = getOAuthStoragePath(serverUrl);
  const f = file(path);

  if (!(await f.exists())) {
    // Back-compat: read legacy ~/.routermcp/mcp-oauth/<hash>/auth.json if present.
    const legacyPath = getLegacyOAuthStoragePath(serverUrl);
    const legacy = file(legacyPath);
    if (await legacy.exists()) {
      try {
        const text = await legacy.text();
        const data = JSON.parse(text) as OAuthStorageData;

        if (data.serverUrl !== serverUrl) {
          console.error(
            `[oauth] Warning: Hash collision detected for ${serverUrl}, ignoring legacy data`,
          );
          return null;
        }

        return data;
      } catch (err) {
        console.error(`[oauth] Error loading legacy OAuth storage: ${err}`);
        return null;
      }
    }

    return null;
  }

  try {
    const text = await f.text();
    const data = JSON.parse(text) as OAuthStorageData;

    if (data.serverUrl !== serverUrl) {
      console.error(
        `[oauth] Warning: Hash collision detected for ${serverUrl}, clearing stale data`,
      );
      await clearOAuthStorage(serverUrl);
      return null;
    }

    return data;
  } catch (err) {
    console.error(`[oauth] Error loading OAuth storage: ${err}`);
    return null;
  }
}

export async function saveOAuthStorage(
  serverUrl: string,
  updates: Partial<Omit<OAuthStorageData, "serverUrl" | "lastUpdated">>,
): Promise<void> {
  await ensureOAuthDir(serverUrl);

  const existing = await loadOAuthStorage(serverUrl);
  const data: OAuthStorageData = {
    serverUrl,
    lastUpdated: Date.now(),
    clientInfo: updates.clientInfo ?? existing?.clientInfo,
    tokens: updates.tokens ?? existing?.tokens,
    codeVerifier: updates.codeVerifier ?? existing?.codeVerifier,
  };

  const path = getOAuthStoragePath(serverUrl);
  await write(path, JSON.stringify(data, null, 2));
}

export async function saveClientInfo(
  serverUrl: string,
  clientInfo: OAuthClientInfo,
): Promise<void> {
  await saveOAuthStorage(serverUrl, { clientInfo });
}

export async function saveTokens(serverUrl: string, tokens: OAuthTokensData): Promise<void> {
  await saveOAuthStorage(serverUrl, { tokens });
}

export async function saveCodeVerifier(serverUrl: string, codeVerifier: string): Promise<void> {
  await saveOAuthStorage(serverUrl, { codeVerifier });
}

export async function clearCodeVerifier(serverUrl: string): Promise<void> {
  const existing = await loadOAuthStorage(serverUrl);
  if (existing) {
    await saveOAuthStorage(serverUrl, {
      clientInfo: existing.clientInfo,
      tokens: existing.tokens,
      codeVerifier: undefined,
    });
  }
}

export async function clearOAuthStorage(serverUrl: string): Promise<void> {
  const dir = getOAuthStorageDir(serverUrl);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {}
}

export async function clearAllOAuthStorage(): Promise<void> {
  try {
    await rm(OAUTH_DIR, { recursive: true, force: true });
  } catch {}
}

export async function listOAuthServers(): Promise<OAuthServerStatus[]> {
  const results: OAuthServerStatus[] = [];

  try {
    await mkdir(OAUTH_DIR, { recursive: true });
    const entries = await readdir(OAUTH_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const authPath = join(OAUTH_DIR, entry.name, "auth.json");
      const f = file(authPath);

      if (!(await f.exists())) continue;

      try {
        const text = await f.text();
        const data = JSON.parse(text) as OAuthStorageData;
        const now = Math.floor(Date.now() / 1000);

        results.push({
          serverUrl: data.serverUrl,
          hostHash: entry.name,
          hasTokens: !!data.tokens?.access_token,
          hasClientInfo: !!data.clientInfo?.client_id,
          expiresAt: data.tokens?.expires_at,
          isExpired: data.tokens?.expires_at ? data.tokens.expires_at < now : false,
        });
      } catch {}
    }
  } catch {}

  return results;
}

export function isTokenExpired(tokens: OAuthTokensData | undefined, thresholdSeconds = 0): boolean {
  if (!tokens?.expires_at) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return tokens.expires_at <= now + thresholdSeconds;
}

export function isClientSecretExpired(clientInfo: OAuthClientInfo | undefined): boolean {
  if (!clientInfo?.client_secret_expires_at) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return clientInfo.client_secret_expires_at <= now;
}
