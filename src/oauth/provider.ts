import {
  selectClientAuthMethod,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { DEFAULT_CLIENT_METADATA_URL } from "./constants.js";
import {
  createOAuthCallbackServer,
  type OAuthCallbackResult,
  type OAuthCallbackServer,
} from "./callback-server.js";
import {
  clearOAuthStorage,
  isClientSecretExpired,
  loadOAuthStorage,
  type OAuthClientInfo,
  type OAuthTokensData,
  saveOAuthStorage,
} from "./storage.js";
import { discoverOAuthServer } from "./discovery.js";

export const DEFAULT_CLIENT_NAME = "RouterMCP";
const DEFAULT_LOOPBACK_REDIRECT_URI = "http://127.0.0.1/oauth/callback";

type RouterMcpOAuthClientMetadata = OAuthClientMetadata & { application_type: "native" };

function formEncode(value: string): string {
  return new URLSearchParams([["value", value]]).toString().slice("value=".length);
}

export interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  clientName?: string;
  clientMetadataUrl?: string;
}

export interface OAuthProviderCallbacks {
  onAuthorizationUrl: (url: URL) => void;
  onAuthorizationComplete: () => void;
  onError: (error: Error) => void;
}

export class RouterMcpOAuthProvider implements OAuthClientProvider {
  private callbackServer: OAuthCallbackServer | null = null;
  private _codeVerifier: string | null = null;
  private _pendingClientInfo: OAuthClientInfo | null = null;
  private _resolvedClientInfo: OAuthClientInfo | null = null;
  private _clientInformationResolved = false;
  private _authorizationCode: string | null = null;
  private _callbackPromise: Promise<OAuthCallbackResult> | null = null;
  private _authorizationServerIssuer: string | null = null;
  private _authorizationServerUrl: URL | null = null;
  private _authorizationServerTokenEndpoint: string | null = null;
  private _authorizationServerSupportsCimd = false;
  private _tokensInvalidated = false;
  private _authorizationRedirectUrl: string | null = null;

  readonly addClientAuthentication: NonNullable<OAuthClientProvider["addClientAuthentication"]> =
    (headers, params, url, metadata) =>
      this.addPinnedClientAuthentication(headers, params, url, metadata);

  constructor(
    private serverName: string,
    private serverUrl: string,
    private config: OAuthProviderConfig,
    private callbacks: OAuthProviderCallbacks,
  ) {}

  get redirectUrl(): string {
    if (this.callbackServer) {
      return this.callbackServer.callbackUrl;
    }
    return this._authorizationRedirectUrl ?? DEFAULT_LOOPBACK_REDIRECT_URI;
  }

  get clientMetadataUrl(): string {
    return this.config.clientMetadataUrl ?? DEFAULT_CLIENT_METADATA_URL;
  }

  get clientMetadata(): RouterMcpOAuthClientMetadata {
    const metadata: RouterMcpOAuthClientMetadata = {
      application_type: "native",
      redirect_uris: [this.redirectUrl],
      client_name: this.config.clientName ?? DEFAULT_CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    };

    // Only include scope if explicitly configured (some servers reject undefined scope)
    if (this.config.scopes && this.config.scopes.length > 0) {
      metadata.scope = this.config.scopes.join(" ");
    }

    return metadata;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const discovery = await discoverOAuthServer(this.serverUrl);
    this.pinAuthorizationServer(discovery);

    if (this._clientInformationResolved) {
      this._authorizationServerSupportsCimd =
        discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true;
      const info = this._pendingClientInfo ?? this._resolvedClientInfo;
      return info
        ? {
            client_id: info.client_id,
            client_secret: info.client_secret,
          }
        : undefined;
    }

    this._authorizationServerSupportsCimd =
      discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true;

    const stored = await loadOAuthStorage(this.serverUrl);
    const hasUnboundStoredCredentials = Boolean(
      stored &&
        !stored.authorizationServerIssuer &&
        (stored.clientInfo || stored.tokens),
    );

    if (hasUnboundStoredCredentials) {
      this._tokensInvalidated = true;
      await clearOAuthStorage(this.serverUrl);
      console.error(
        `[oauth] Legacy credentials for ${this.serverName} have no authorization server binding; re-authentication is required`,
      );
    }

    if (
      stored?.authorizationServerIssuer &&
      stored.authorizationServerIssuer !== this._authorizationServerIssuer
    ) {
      if (this.config.clientId) {
        throw new Error(
          `OAuth client for ${this.serverName} is bound to authorization server ${stored.authorizationServerIssuer}, but discovery returned ${this._authorizationServerIssuer}`,
        );
      }

      this._tokensInvalidated = true;
      console.error(
        `[oauth] Authorization server changed for ${this.serverName}; registering a client with the new issuer`,
      );
    }

    const storedClientInfoMatchesIssuer =
      !!stored?.authorizationServerIssuer &&
      stored.authorizationServerIssuer === this._authorizationServerIssuer;

    if (this.config.clientId) {
      if (stored?.clientInfo && stored.clientInfo.client_id !== this.config.clientId) {
        this._tokensInvalidated = true;
      }
      this._resolvedClientInfo = {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      };
      this._clientInformationResolved = true;
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      };
    }

    if (stored?.clientInfo && !storedClientInfoMatchesIssuer) {
      this._resolvedClientInfo = null;
    } else if (
      stored?.clientInfo?.clientMetadataUrl &&
      stored.clientInfo.clientMetadataUrl !== this.clientMetadataUrl
    ) {
      this._tokensInvalidated = true;
      this._resolvedClientInfo = null;
      console.error(
        `[oauth] Client metadata URL changed for ${this.serverName}; re-authentication is required`,
      );
    } else if (stored?.clientInfo && isClientSecretExpired(stored.clientInfo)) {
      this._tokensInvalidated = true;
      this._resolvedClientInfo = null;
      console.error(`[oauth] Client secret expired for ${this.serverName}, need re-registration`);
    } else if (stored?.clientInfo) {
      this._resolvedClientInfo = stored.clientInfo;
    }

    if (!this._resolvedClientInfo && stored?.tokens) {
      this._tokensInvalidated = true;
    }

    this._clientInformationResolved = true;

    if (!this._resolvedClientInfo) {
      // SDK registration reads redirect_uris before redirectToAuthorization runs.
      // Bind the actual ephemeral loopback URI before it can issue a DCR request.
      await this.startCallbackServer();
      return undefined;
    }

    return {
      client_id: this._resolvedClientInfo.client_id,
      client_secret: this._resolvedClientInfo.client_secret,
    };
  }

  private pinAuthorizationServer(discovery: Awaited<ReturnType<typeof discoverOAuthServer>>): void {
    const tokenEndpoint = new URL(
      discovery.authorizationServerMetadata?.token_endpoint ??
        new URL("/token", discovery.authorizationServerUrl),
    ).href;

    if (this._authorizationServerIssuer !== null) {
      if (
        this._authorizationServerIssuer !== discovery.authorizationServerIssuer ||
        this._authorizationServerTokenEndpoint !== tokenEndpoint
      ) {
        this._tokensInvalidated = true;
        throw new Error(
          `Authorization server changed during OAuth authentication for ${this.serverName}; restart authentication with ${discovery.authorizationServerIssuer}`,
        );
      }
      return;
    }

    this._authorizationServerIssuer = discovery.authorizationServerIssuer;
    this._authorizationServerUrl = new URL(discovery.authorizationServerUrl);
    this._authorizationServerTokenEndpoint = tokenEndpoint;
  }

  private addPinnedClientAuthentication(
    headers: Headers,
    params: URLSearchParams,
    url: string | URL,
    metadata?: AuthorizationServerMetadata,
  ): void {
    const issuer = this._authorizationServerIssuer;
    const pinnedTokenEndpoint = this._authorizationServerTokenEndpoint;
    if (!issuer || !pinnedTokenEndpoint || !this._authorizationServerUrl) {
      throw new Error(
        `Cannot authenticate a token request for ${this.serverName} before authorization server discovery`,
      );
    }

    const requestTokenEndpoint = new URL(url).href;
    if (metadata) {
      if (metadata.issuer !== issuer) {
        this.rejectTokenRequest(
          `Refusing OAuth token request for ${this.serverName}: SDK issuer ${metadata.issuer} does not match discovered issuer ${issuer}`,
        );
      }

      const metadataTokenEndpoint = new URL(metadata.token_endpoint).href;
      if (requestTokenEndpoint !== metadataTokenEndpoint) {
        this.rejectTokenRequest(
          `Refusing OAuth token request for ${this.serverName}: request target does not match SDK token endpoint`,
        );
      }
      if (requestTokenEndpoint !== pinnedTokenEndpoint) {
        this.rejectTokenRequest(
          `Refusing OAuth token request for ${this.serverName}: SDK token endpoint does not match the discovered token endpoint`,
        );
      }
    } else {
      const legacyTokenEndpoint = new URL("/token", this._authorizationServerUrl).href;
      if (
        requestTokenEndpoint !== pinnedTokenEndpoint ||
        requestTokenEndpoint !== legacyTokenEndpoint
      ) {
        this.rejectTokenRequest(
          `Refusing OAuth token request for ${this.serverName}: request target does not match the discovered token endpoint`,
        );
      }
    }

    const clientInformation =
      this._pendingClientInfo ??
      this._resolvedClientInfo ??
      (this.config.clientId
        ? { client_id: this.config.clientId, client_secret: this.config.clientSecret }
        : undefined);
    if (!clientInformation) {
      throw new Error(`OAuth client information is unavailable for ${this.serverName}`);
    }

    const method = selectClientAuthMethod(
      clientInformation,
      metadata?.token_endpoint_auth_methods_supported ?? [],
    );
    headers.delete("Authorization");

    switch (method) {
      case "client_secret_basic": {
        if (!clientInformation.client_secret) {
          throw new Error("client_secret_basic authentication requires a client_secret");
        }
        const credentials = `${formEncode(clientInformation.client_id)}:${formEncode(
          clientInformation.client_secret,
        )}`;
        headers.set("Authorization", `Basic ${btoa(credentials)}`);
        return;
      }
      case "client_secret_post":
        params.set("client_id", clientInformation.client_id);
        if (clientInformation.client_secret) {
          params.set("client_secret", clientInformation.client_secret);
        }
        return;
      case "none":
        params.set("client_id", clientInformation.client_id);
        return;
    }
  }

  private rejectTokenRequest(message: string): never {
    throw new InvalidRequestError(message);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this._pendingClientInfo = {
      client_id: info.client_id,
      client_secret: info.client_secret,
      ...("client_id_issued_at" in info ? { client_id_issued_at: info.client_id_issued_at } : {}),
      ...("client_secret_expires_at" in info
        ? { client_secret_expires_at: info.client_secret_expires_at }
        : {}),
      ...(this._authorizationServerSupportsCimd && info.client_id === this.clientMetadataUrl
        ? { clientMetadataUrl: this.clientMetadataUrl }
        : {}),
    };
    this._resolvedClientInfo = this._pendingClientInfo;
    this._clientInformationResolved = true;
    console.error(`[oauth] Client registered for ${this.serverName} (pending token exchange)`);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this._tokensInvalidated) return undefined;

    const stored = await loadOAuthStorage(this.serverUrl);
    if (!stored?.tokens) {
      return undefined;
    }
    if (
      !stored.authorizationServerIssuer ||
      (this._authorizationServerIssuer !== null &&
        stored.authorizationServerIssuer !== this._authorizationServerIssuer)
    ) {
      this._tokensInvalidated = true;
      return undefined;
    }

    return {
      access_token: stored.tokens.access_token,
      token_type: stored.tokens.token_type,
      refresh_token: stored.tokens.refresh_token,
      expires_in: stored.tokens.expires_at
        ? Math.max(0, Math.floor(stored.tokens.expires_at - Date.now() / 1000))
        : undefined,
      scope: stored.tokens.scope,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const tokensData: OAuthTokensData = {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in ? Math.floor(Date.now() / 1000) + tokens.expires_in : undefined,
      scope: tokens.scope,
    };

    await saveOAuthStorage(this.serverUrl, {
      clientInfo:
        this._pendingClientInfo ??
        (this.config.clientId
          ? { client_id: this.config.clientId, client_secret: this.config.clientSecret }
          : undefined),
      authorizationServerIssuer: this._authorizationServerIssuer ?? undefined,
      tokens: tokensData,
    });
    this._tokensInvalidated = false;
    console.error(`[oauth] Saved credentials for ${this.serverName}`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.callbackServer) {
      this.callbackServer = await createOAuthCallbackServer();
      await this.callbackServer.start();
      authorizationUrl.searchParams.set("redirect_uri", this.callbackServer.callbackUrl);
    }
    this._authorizationRedirectUrl = this.callbackServer.callbackUrl;

    this.callbacks.onAuthorizationUrl(authorizationUrl);

    this._callbackPromise = this.callbackServer.waitForCallback();
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (!this._callbackPromise) {
      throw new Error("No pending authorization - call redirectToAuthorization first");
    }

    try {
      const result = await this._callbackPromise;
      this._authorizationCode = result.code;
      this.callbacks.onAuthorizationComplete();
      return result.code;
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this._callbackPromise = null;
    }
  }

  getAuthorizationCode(): string | null {
    return this._authorizationCode;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (this._codeVerifier) {
      return this._codeVerifier;
    }

    const stored = await loadOAuthStorage(this.serverUrl);
    if (!stored?.codeVerifier) {
      throw new Error(`No code verifier saved for ${this.serverName}`);
    }
    return stored.codeVerifier;
  }

  async startCallbackServer(): Promise<string> {
    if (!this.callbackServer) {
      this.callbackServer = await createOAuthCallbackServer();
      await this.callbackServer.start();
    }
    this._authorizationRedirectUrl = this.callbackServer.callbackUrl;
    return this.callbackServer.callbackUrl;
  }

  async stopCallbackServer(): Promise<void> {
    if (this.callbackServer) {
      await this.callbackServer.stop();
      this.callbackServer = null;
    }
  }

  getCallbackUrl(): string | null {
    return this.callbackServer?.callbackUrl ?? null;
  }
}

export function createOAuthProvider(
  serverName: string,
  serverUrl: string,
  config: OAuthProviderConfig,
  callbacks: OAuthProviderCallbacks,
): RouterMcpOAuthProvider {
  return new RouterMcpOAuthProvider(serverName, serverUrl, config, callbacks);
}
