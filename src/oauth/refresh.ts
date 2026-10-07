import { refreshAuthorization, selectResourceURL } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthConfig } from "../config/types.js";
import { DEFAULT_CLIENT_METADATA_URL } from "./constants.js";
import { discoverOAuthServer } from "./discovery.js";
import { DEFAULT_CLIENT_NAME, RouterMcpOAuthProvider } from "./provider.js";
import {
  isTokenExpired,
  loadOAuthStorage,
  type OAuthTokensData,
  saveOAuthStorage,
  saveTokens,
} from "./storage.js";

const TOKEN_REFRESH_THRESHOLD_SECONDS = 300;

export type RefreshStatus = "valid" | "refreshed" | "expired" | "no-tokens" | "error";

export interface RefreshResult {
  serverUrl: string;
  status: RefreshStatus;
  error?: string;
}

export async function ensureValidTokens(
  serverUrl: string,
  config?: OAuthConfig,
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

    if (!stored.authorizationServerIssuer) {
      return {
        serverUrl,
        status: "error",
        error: "Stored OAuth credentials have no authorization server binding; re-authentication is required",
      };
    }

    const discovery = await discoverOAuthServer(serverUrl);
    if (
      stored.authorizationServerIssuer &&
      stored.authorizationServerIssuer !== discovery.authorizationServerIssuer
    ) {
      return {
        serverUrl,
        status: "error",
        error: config?.clientId
          ? `Configured OAuth client is bound to ${stored.authorizationServerIssuer}, but discovery returned ${discovery.authorizationServerIssuer}`
          : `Stored OAuth client registration is bound to ${stored.authorizationServerIssuer}, but discovery returned ${discovery.authorizationServerIssuer}`,
      };
    }

    let clientInformation = stored.clientInfo;
    if (config?.clientId) {
      if (stored.clientInfo && stored.clientInfo.client_id !== config.clientId) {
        return {
          serverUrl,
          status: "error",
          error:
            "Configured OAuth client differs from the client that issued these tokens; re-authentication is required",
        };
      }
      clientInformation = {
        client_id: config.clientId,
        client_secret: config.clientSecret,
      };
    } else if (
      stored.clientInfo?.clientMetadataUrl &&
      stored.clientInfo.clientMetadataUrl !==
        (config?.clientMetadataUrl ?? DEFAULT_CLIENT_METADATA_URL)
    ) {
      return {
        serverUrl,
        status: "error",
        error:
          "Configured client metadata URL differs from the client that issued these tokens; re-authentication is required",
      };
    } else if (
      !clientInformation &&
      discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true
    ) {
      const clientMetadataUrl = config?.clientMetadataUrl ?? DEFAULT_CLIENT_METADATA_URL;
      if (!isValidClientMetadataUrl(clientMetadataUrl)) {
        return {
          serverUrl,
          status: "error",
          error: "Client metadata URL must be HTTPS and include a non-root path",
        };
      }
      clientInformation = { client_id: clientMetadataUrl };
    }

    if (!clientInformation) {
      return {
        serverUrl,
        status: "error",
        error: "No client info available for token refresh",
      };
    }

    const provider = new RouterMcpOAuthProvider(
      "token refresh",
      serverUrl,
      {
        clientId: config?.clientId,
        clientSecret: config?.clientSecret,
        scopes: config?.scopes,
        clientName: config?.clientName ?? DEFAULT_CLIENT_NAME,
        clientMetadataUrl: config?.clientMetadataUrl,
      },
      {
        onAuthorizationUrl: () => {},
        onAuthorizationComplete: () => {},
        onError: () => {},
      },
    );
    const resource = await selectResourceURL(serverUrl, provider, discovery.resourceMetadata);

    const newTokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      refreshToken: stored.tokens.refresh_token,
      resource,
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
    await saveOAuthStorage(serverUrl, {
      authorizationServerIssuer: discovery.authorizationServerIssuer,
    });
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

function isValidClientMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
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
