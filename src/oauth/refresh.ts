import {
  discoverOAuthMetadata,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthConfig } from "../config/types.js";
import { type OAuthTokensData, isTokenExpired, loadOAuthStorage, saveTokens } from "./storage.js";

const TOKEN_REFRESH_THRESHOLD_SECONDS = 300;

export type RefreshStatus = "valid" | "refreshed" | "expired" | "no-tokens" | "error";

export interface RefreshResult {
  serverUrl: string;
  status: RefreshStatus;
  error?: string;
}

export async function ensureValidTokens(
  serverUrl: string,
  _config?: OAuthConfig,
): Promise<RefreshResult> {
  try {
    const stored = await loadOAuthStorage(serverUrl);

    if (!stored?.tokens) {
      return { serverUrl, status: "no-tokens" };
    }

    if (!isTokenExpired(stored.tokens, TOKEN_REFRESH_THRESHOLD_SECONDS)) {
      return { serverUrl, status: "valid" };
    }

    if (!stored.tokens.refresh_token) {
      if (isTokenExpired(stored.tokens, 0)) {
        return { serverUrl, status: "expired" };
      }
      return { serverUrl, status: "valid" };
    }

    const metadata = await discoverOAuthMetadata(serverUrl);
    if (!metadata) {
      return {
        serverUrl,
        status: "error",
        error: "Could not discover OAuth metadata for token refresh",
      };
    }

    if (!stored.clientInfo) {
      return {
        serverUrl,
        status: "error",
        error: "No client info available for token refresh",
      };
    }

    const newTokens = await refreshAuthorization(serverUrl, {
      clientInformation: {
        client_id: stored.clientInfo.client_id,
        client_secret: stored.clientInfo.client_secret,
      },
      refreshToken: stored.tokens.refresh_token,
    });

    const tokensData: OAuthTokensData = {
      access_token: newTokens.access_token,
      token_type: newTokens.token_type,
      refresh_token: newTokens.refresh_token || stored.tokens.refresh_token,
      expires_at: newTokens.expires_in
        ? Math.floor(Date.now() / 1000) + newTokens.expires_in
        : undefined,
      scope: newTokens.scope,
    };

    await saveTokens(serverUrl, tokensData);
    console.error(`[oauth] Refreshed tokens for ${serverUrl}`);

    return { serverUrl, status: "refreshed" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    const stored = await loadOAuthStorage(serverUrl);
    if (stored?.tokens && isTokenExpired(stored.tokens, 0)) {
      return { serverUrl, status: "expired", error: errorMsg };
    }

    return { serverUrl, status: "error", error: errorMsg };
  }
}

export async function refreshAllTokens(
  servers: Map<string, { url?: string; oauth?: OAuthConfig }>,
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  for (const [, config] of servers) {
    if (!config.url || !config.oauth) continue;

    const result = await ensureValidTokens(config.url, config.oauth);
    results.push(result);
  }

  return results;
}
