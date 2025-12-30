import { serve, type ServerHandle } from "../../src/compat/index.js";
import { createServer } from "node:net";

export interface MockOAuthServerConfig {
	issuer?: string;
	clientId?: string;
	clientSecret?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresIn?: number;
}

export interface MockOAuthServer {
	port: number;
	baseUrl: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	getTokenRequests(): TokenRequest[];
	getRegistrationRequests(): RegistrationRequest[];
}

export interface TokenRequest {
	grantType: string;
	code?: string;
	refreshToken?: string;
	clientId?: string;
}

export interface RegistrationRequest {
	clientName?: string;
	redirectUris?: string[];
}

async function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error("Failed to get port")));
			}
		});
		server.on("error", reject);
	});
}

export async function createMockOAuthServer(
	config: MockOAuthServerConfig = {}
): Promise<MockOAuthServer> {
	const port = await findAvailablePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	const {
		issuer = baseUrl,
		clientId = "mock-client-id",
		clientSecret = "mock-client-secret",
		accessToken = "mock-access-token",
		refreshToken = "mock-refresh-token",
		expiresIn = 3600,
	} = config;

	let httpServer: ServerHandle | null = null;
	const tokenRequests: TokenRequest[] = [];
	const registrationRequests: RegistrationRequest[] = [];

	const oauthMetadata = {
		issuer,
		authorization_endpoint: `${baseUrl}/authorize`,
		token_endpoint: `${baseUrl}/token`,
		registration_endpoint: `${baseUrl}/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
	};

	const server: MockOAuthServer = {
		port,
		baseUrl,

		async start(): Promise<void> {
			httpServer = serve({
				port,
				fetch: async (request: Request): Promise<Response> => {
					const url = new URL(request.url);

					if (url.pathname === "/.well-known/oauth-authorization-server") {
						return new Response(JSON.stringify(oauthMetadata), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					}

					if (url.pathname === "/register" && request.method === "POST") {
						const body = await request.json();
						registrationRequests.push({
							clientName: body.client_name,
							redirectUris: body.redirect_uris,
						});

						const now = Math.floor(Date.now() / 1000);
						return new Response(
							JSON.stringify({
								client_id: clientId,
								client_secret: clientSecret,
								client_id_issued_at: now,
								client_secret_expires_at: now + 86400 * 30,
								redirect_uris: body.redirect_uris,
								client_name: body.client_name,
								token_endpoint_auth_method: body.token_endpoint_auth_method || "client_secret_post",
							}),
							{
								status: 201,
								headers: { "Content-Type": "application/json" },
							}
						);
					}

					if (url.pathname === "/token" && request.method === "POST") {
						const formData = await request.formData();
						const grantType = formData.get("grant_type") as string;

						tokenRequests.push({
							grantType,
							code: formData.get("code") as string | undefined,
							refreshToken: formData.get("refresh_token") as string | undefined,
							clientId: formData.get("client_id") as string | undefined,
						});

						if (grantType === "authorization_code") {
							return new Response(
								JSON.stringify({
									access_token: accessToken,
									token_type: "Bearer",
									expires_in: expiresIn,
									refresh_token: refreshToken,
									scope: "read write",
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								}
							);
						}

						if (grantType === "refresh_token") {
							return new Response(
								JSON.stringify({
									access_token: `${accessToken}-refreshed`,
									token_type: "Bearer",
									expires_in: expiresIn,
									refresh_token: refreshToken,
									scope: "read write",
								}),
								{
									status: 200,
									headers: { "Content-Type": "application/json" },
								}
							);
						}

						return new Response(
							JSON.stringify({ error: "unsupported_grant_type" }),
							{
								status: 400,
								headers: { "Content-Type": "application/json" },
							}
						);
					}

					if (url.pathname === "/authorize") {
						const redirectUri = url.searchParams.get("redirect_uri");
						const state = url.searchParams.get("state");
						const code = "mock-authorization-code";

						if (redirectUri) {
							const callbackUrl = new URL(redirectUri);
							callbackUrl.searchParams.set("code", code);
							if (state) {
								callbackUrl.searchParams.set("state", state);
							}

							return new Response(null, {
								status: 302,
								headers: { Location: callbackUrl.toString() },
							});
						}

						return new Response("Missing redirect_uri", { status: 400 });
					}

					return new Response("Not Found", { status: 404 });
				},
			});
		},

		async stop(): Promise<void> {
			if (httpServer) {
				httpServer.stop();
				httpServer = null;
			}
		},

		getTokenRequests(): TokenRequest[] {
			return [...tokenRequests];
		},

		getRegistrationRequests(): RegistrationRequest[] {
			return [...registrationRequests];
		},
	};

	return server;
}
