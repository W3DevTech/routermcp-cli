import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthServerDiscovery {
  authorizationServerUrl: URL;
  authorizationServerIssuer: string;
  authorizationServerMetadata?: AuthorizationServerMetadata;
  resourceMetadata?: OAuthProtectedResourceMetadata;
}

/**
 * Resolve the authorization server using the same protected-resource discovery
 * and legacy root fallback as the MCP SDK's auth() implementation.
 */
export async function discoverOAuthServer(serverUrl: string): Promise<OAuthServerDiscovery> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;

  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
  } catch {
    // The SDK falls back to authorization-server discovery at the resource origin.
  }

  const authorizationServerUrl =
    resourceMetadata?.authorization_servers?.[0] ?? new URL("/", serverUrl);
  const authorizationServerMetadata =
    await discoverAuthorizationServerMetadata(authorizationServerUrl);

  return {
    authorizationServerUrl: new URL(authorizationServerUrl),
    authorizationServerIssuer:
      authorizationServerMetadata?.issuer ?? authorizationServerUrl.toString(),
    authorizationServerMetadata,
    resourceMetadata,
  };
}
