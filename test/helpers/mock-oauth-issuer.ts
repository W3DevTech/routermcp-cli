import { type ServerHandle, serve } from "../../src/compat/index.js";

export interface OAuthRegistrationRequest {
  application_type?: string;
  client_name?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
}

export interface OAuthTokenRequest {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  code?: string;
  redirect_uri?: string;
  refresh_token?: string;
  resource?: string;
}

export interface MockOAuthIssuer {
  readonly authorizationServerUrl: string;
  readonly resourceUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  setAuthorizationServerUrl(url: string): void;
  setCimdSupported(supported: boolean): void;
  getRegistrationRequests(): OAuthRegistrationRequest[];
  getTokenRequests(): OAuthTokenRequest[];
  getRequests(): Array<{ url: string; method: string }>;
}

export async function createMockOAuthIssuer(
  options: { cimdSupported?: boolean; metadataSupported?: boolean } = {},
): Promise<MockOAuthIssuer> {
  let authorizationServer: ServerHandle | null = null;
  let resourceServer: ServerHandle | null = null;
  let authorizationServerUrl = "";
  let resourceUrl = "";
  let protectedResourceAuthorizationServerUrl: string | null = null;
  let cimdSupported = options.cimdSupported ?? false;
  const metadataSupported = options.metadataSupported ?? true;
  const registrationRequests: OAuthRegistrationRequest[] = [];
  const tokenRequests: OAuthTokenRequest[] = [];
  const requests: Array<{ url: string; method: string }> = [];

  return {
    get authorizationServerUrl() {
      return authorizationServerUrl;
    },

    get resourceUrl() {
      return resourceUrl;
    },

    async start(): Promise<void> {
      authorizationServer = serve({
        port: 0,
        host: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url);
          requests.push({ url: url.toString(), method: request.method });

          if (url.pathname === "/.well-known/oauth-authorization-server") {
            if (!metadataSupported) {
              return new Response("Not Found", { status: 404 });
            }
            return Response.json({
              issuer: authorizationServerUrl,
              authorization_endpoint: `${authorizationServerUrl}/authorize`,
              token_endpoint: `${authorizationServerUrl}/token`,
              registration_endpoint: `${authorizationServerUrl}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
              client_id_metadata_document_supported: cimdSupported,
            });
          }

          if (url.pathname === "/register" && request.method === "POST") {
            const metadata = (await request.json()) as OAuthRegistrationRequest;
            registrationRequests.push(metadata);
            return Response.json(
              {
                ...metadata,
                client_id: `registered-client-${new URL(authorizationServerUrl).port}-${registrationRequests.length}`,
                client_id_issued_at: Math.floor(Date.now() / 1000),
              },
              { status: 201 },
            );
          }

          if (url.pathname === "/token" && request.method === "POST") {
            const form = await request.formData();
            const tokenRequest: OAuthTokenRequest = {};
            for (const [key, value] of form.entries()) {
              if (typeof value === "string") {
                tokenRequest[key as keyof OAuthTokenRequest] = value;
              }
            }
            tokenRequests.push(tokenRequest);

            return Response.json({
              access_token: `access-${tokenRequests.length}`,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token:
                tokenRequest.grant_type === "refresh_token"
                  ? "rotated-refresh-token"
                  : "initial-refresh-token",
            });
          }

          return new Response("Not Found", { status: 404 });
        },
      });
      authorizationServerUrl = `http://127.0.0.1:${await authorizationServer.ready}`;

      resourceServer = serve({
        port: 0,
        host: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url);
          requests.push({ url: url.toString(), method: request.method });
          if (!metadataSupported && url.pathname === "/token" && request.method === "POST") {
            const form = await request.formData();
            const tokenRequest: OAuthTokenRequest = {};
            for (const [key, value] of form.entries()) {
              if (typeof value === "string") {
                tokenRequest[key as keyof OAuthTokenRequest] = value;
              }
            }
            tokenRequests.push(tokenRequest);

            return Response.json({
              access_token: `access-${tokenRequests.length}`,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token:
                tokenRequest.grant_type === "refresh_token"
                  ? "rotated-refresh-token"
                  : "initial-refresh-token",
            });
          }

          if (
            url.pathname === "/.well-known/oauth-protected-resource" ||
            url.pathname === "/.well-known/oauth-protected-resource/mcp"
          ) {
            if (!metadataSupported) {
              return new Response("Not Found", { status: 404 });
            }
            return Response.json({
              resource: resourceUrl,
              authorization_servers: [
                protectedResourceAuthorizationServerUrl ?? authorizationServerUrl,
              ],
              scopes_supported: ["read", "write"],
            });
          }
          return new Response("Not Found", { status: 404 });
        },
      });
      resourceUrl = `http://127.0.0.1:${await resourceServer.ready}/mcp`;
    },

    async stop(): Promise<void> {
      resourceServer?.stop();
      resourceServer = null;
      authorizationServer?.stop();
      authorizationServer = null;
    },

    setAuthorizationServerUrl(url: string): void {
      protectedResourceAuthorizationServerUrl = url;
    },

    setCimdSupported(supported: boolean): void {
      cimdSupported = supported;
    },

    getRegistrationRequests(): OAuthRegistrationRequest[] {
      return [...registrationRequests];
    },

    getTokenRequests(): OAuthTokenRequest[] {
      return [...tokenRequests];
    },

    getRequests(): Array<{ url: string; method: string }> {
      return [...requests];
    },
  };
}
