import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  loadOAuthStorage,
  saveOAuthStorage,
  isClientSecretExpired,
  type OAuthClientInfo,
  type OAuthTokensData,
} from "./storage.js";
import { createOAuthCallbackServer, type OAuthCallbackServer, type OAuthCallbackResult } from "./callback-server.js";

export const DEFAULT_CLIENT_NAME = "RouterMCP";

export interface OAuthProviderConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  clientName?: string;
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
  private _authorizationCode: string | null = null;
  private _callbackPromise: Promise<OAuthCallbackResult> | null = null;

  constructor(
    private serverName: string,
    private serverUrl: string,
    private config: OAuthProviderConfig,
    private callbacks: OAuthProviderCallbacks
  ) {}

  get redirectUrl(): string {
    if (this.callbackServer) {
      return this.callbackServer.callbackUrl;
    }
    return "http://127.0.0.1:0/oauth/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
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
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      };
    }

    if (this._pendingClientInfo) {
      return {
        client_id: this._pendingClientInfo.client_id,
        client_secret: this._pendingClientInfo.client_secret,
      };
    }

    const stored = await loadOAuthStorage(this.serverUrl);
    if (!stored?.clientInfo) {
      return undefined;
    }

    if (isClientSecretExpired(stored.clientInfo)) {
      console.error(`[oauth] Client secret expired for ${this.serverName}, need re-registration`);
      return undefined;
    }

    return {
      client_id: stored.clientInfo.client_id,
      client_secret: stored.clientInfo.client_secret,
    };
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this._pendingClientInfo = {
      client_id: info.client_id,
      client_secret: info.client_secret,
      client_id_issued_at: info.client_id_issued_at,
      client_secret_expires_at: info.client_secret_expires_at,
    };
    console.error(`[oauth] Client registered for ${this.serverName} (pending token exchange)`);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await loadOAuthStorage(this.serverUrl);
    if (!stored?.tokens) {
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
      expires_at: tokens.expires_in
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : undefined,
      scope: tokens.scope,
    };

    await saveOAuthStorage(this.serverUrl, {
      clientInfo: this._pendingClientInfo ?? undefined,
      tokens: tokensData,
    });
    console.error(`[oauth] Saved credentials for ${this.serverName}`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.callbackServer) {
      this.callbackServer = await createOAuthCallbackServer();
      await this.callbackServer.start();
      authorizationUrl.searchParams.set("redirect_uri", this.callbackServer.callbackUrl);
    }

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
  callbacks: OAuthProviderCallbacks
): RouterMcpOAuthProvider {
  return new RouterMcpOAuthProvider(serverName, serverUrl, config, callbacks);
}
