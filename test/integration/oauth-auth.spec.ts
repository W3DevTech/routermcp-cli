import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testOAuthStorage = vi.hoisted(() => ({
  data: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../../src/oauth/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/oauth/storage.js")>();

  const save = async (serverUrl: string, updates: Record<string, unknown>): Promise<void> => {
    const existing = testOAuthStorage.data.get(serverUrl) ?? {};
    testOAuthStorage.data.set(serverUrl, {
      serverUrl,
      lastUpdated: Date.now(),
      ...existing,
      ...updates,
      authorizationServerIssuer:
        updates.authorizationServerIssuer ?? existing.authorizationServerIssuer,
      clientInfo: updates.clientInfo ?? existing.clientInfo,
      tokens: updates.tokens ?? existing.tokens,
    });
  };

  return {
    ...actual,
    clearOAuthStorage: vi.fn(async (serverUrl: string) => {
      testOAuthStorage.data.delete(serverUrl);
    }),
    loadOAuthStorage: vi.fn(
      async (serverUrl: string) => testOAuthStorage.data.get(serverUrl) ?? null,
    ),
    saveOAuthStorage: vi.fn(save),
    saveTokens: vi.fn(async (serverUrl: string, tokens: Record<string, unknown>) =>
      save(serverUrl, { tokens }),
    ),
  };
});

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthConfig } from "../../src/config/types.js";
import { RouterMcpOAuthProvider, type OAuthProviderCallbacks } from "../../src/oauth/provider.js";
import { ensureValidTokens } from "../../src/oauth/refresh.js";
import { DEFAULT_CLIENT_METADATA_URL } from "../../src/oauth/constants.js";
import { createMockOAuthIssuer, type MockOAuthIssuer } from "../helpers/mock-oauth-issuer.js";

describe("OAuth client authentication boundary", () => {
  let issuer: MockOAuthIssuer;
  const providers: RouterMcpOAuthProvider[] = [];
  const issuers: MockOAuthIssuer[] = [];

  beforeEach(async () => {
    testOAuthStorage.data.clear();
    issuer = await startIssuer();
  });

  afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.stopCallbackServer()));
    await Promise.all(issuers.splice(0).map((server) => server.stop()));
  });

  async function startIssuer(cimdSupported = false): Promise<MockOAuthIssuer> {
    const server = await createMockOAuthIssuer({ cimdSupported });
    await server.start();
    issuers.push(server);
    return server;
  }

  function createProvider(
    server: MockOAuthIssuer,
    config: OAuthConfig = {},
    onAuthorizationUrl: (url: URL) => void = () => {},
  ): RouterMcpOAuthProvider {
    const callbacks: OAuthProviderCallbacks = {
      onAuthorizationUrl,
      onAuthorizationComplete: () => {},
      onError: () => {},
    };
    const provider = new RouterMcpOAuthProvider("mock", server.resourceUrl, config, callbacks);
    providers.push(provider);
    return provider;
  }

  async function finishAuthorization(
    provider: RouterMcpOAuthProvider,
    serverUrl: string,
    authorizationUrl: URL,
  ): Promise<void> {
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    const redirectUrl = new URL(redirectUri!);
    expect(redirectUrl.hostname).toBe("127.0.0.1");
    expect(Number(redirectUrl.port)).toBeGreaterThan(0);
    expect(redirectUrl.pathname).toBe("/oauth/callback");

    const callback = new URL(redirectUrl);
    callback.searchParams.set("code", "mock-code");
    const callbackResponse = await fetch(callback);
    expect(callbackResponse.status).toBe(200);

    const authorizationCode = await provider.waitForAuthorizationCode();
    const result = await auth(provider, { serverUrl, authorizationCode });
    expect(result).toBe("AUTHORIZED");
    const tokenRequest = [...issuer.getTokenRequests()].at(-1);
    expect(tokenRequest?.redirect_uri).toBe(redirectUrl.toString());
    await provider.stopCallbackServer();
  }

  it("uses CIMD only when advertised, then exchanges with the live loopback port", async () => {
    issuer.setCimdSupported(true);
    const authorizationUrls: URL[] = [];
    const provider = createProvider(
      issuer,
      { clientMetadataUrl: "https://clients.example.test/routermcp.json" },
      (url) => authorizationUrls.push(new URL(url)),
    );

    const firstResult = await auth(provider, { serverUrl: issuer.resourceUrl });

    expect(firstResult).toBe("REDIRECT");
    expect(issuer.getRegistrationRequests()).toEqual([]);
    expect(authorizationUrls).toHaveLength(1);
    expect(authorizationUrls[0].searchParams.get("client_id")).toBe(
      "https://clients.example.test/routermcp.json",
    );

    await finishAuthorization(provider, issuer.resourceUrl, authorizationUrls[0]);

    const stored = testOAuthStorage.data.get(issuer.resourceUrl);
    expect(stored?.authorizationServerIssuer).toBe(issuer.authorizationServerUrl);
    expect(stored?.clientInfo).toMatchObject({
      client_id: "https://clients.example.test/routermcp.json",
      clientMetadataUrl: "https://clients.example.test/routermcp.json",
    });
    expect(issuer.getTokenRequests()[0].client_id).toBe(
      "https://clients.example.test/routermcp.json",
    );
  });

  it("registers a native DCR client with the bound ephemeral URI and does not reuse it at a new issuer", async () => {
    const nextIssuer = await startIssuer();
    const authorizationUrls: URL[] = [];
    const firstProvider = createProvider(issuer, {}, (url) => authorizationUrls.push(new URL(url)));

    const firstResult = await auth(firstProvider, { serverUrl: issuer.resourceUrl });
    expect(firstResult).toBe("REDIRECT");
    expect(issuer.getRegistrationRequests()).toHaveLength(1);

    const firstRegistration = issuer.getRegistrationRequests()[0];
    const firstClientId = authorizationUrls[0].searchParams.get("client_id");
    expect(firstRegistration.application_type).toBe("native");
    expect(firstRegistration.redirect_uris).toEqual([
      authorizationUrls[0].searchParams.get("redirect_uri"),
    ]);
    await finishAuthorization(firstProvider, issuer.resourceUrl, authorizationUrls[0]);

    issuer.setAuthorizationServerUrl(nextIssuer.authorizationServerUrl);
    const nextAuthorizationUrls: URL[] = [];
    const nextProvider = createProvider(issuer, {}, (url) =>
      nextAuthorizationUrls.push(new URL(url)),
    );

    const nextResult = await auth(nextProvider, { serverUrl: issuer.resourceUrl });

    expect(nextResult).toBe("REDIRECT");
    expect(nextIssuer.getRegistrationRequests()).toHaveLength(1);
    expect(nextAuthorizationUrls[0].searchParams.get("client_id")).toMatch(/^registered-client-/);
    expect(nextAuthorizationUrls[0].searchParams.get("client_id")).not.toBe(firstClientId);
  });

  it.each([
    { name: "CIMD", cimdSupported: true },
    { name: "DCR", cimdSupported: false },
  ])("replaces an unbound legacy registration with fresh $name credentials", async ({
    cimdSupported,
  }) => {
    issuer.setCimdSupported(cimdSupported);
    testOAuthStorage.data.set(issuer.resourceUrl, {
      serverUrl: issuer.resourceUrl,
      lastUpdated: Date.now(),
      clientInfo: { client_id: "legacy-client", client_secret: "legacy-secret" },
      tokens: {
        access_token: "legacy-access-token",
        token_type: "Bearer",
        refresh_token: "legacy-refresh-token",
        expires_at: Math.floor(Date.now() / 1000) - 10,
      },
    });
    const authorizationUrls: URL[] = [];
    const provider = createProvider(issuer, {}, (url) => authorizationUrls.push(new URL(url)));

    expect(await auth(provider, { serverUrl: issuer.resourceUrl })).toBe("REDIRECT");
    const clientId = authorizationUrls[0].searchParams.get("client_id");
    expect(clientId).not.toBe("legacy-client");
    if (cimdSupported) {
      expect(clientId).toBe(DEFAULT_CLIENT_METADATA_URL);
      expect(issuer.getRegistrationRequests()).toEqual([]);
    } else {
      expect(clientId).toMatch(/^registered-client-/);
      expect(issuer.getRegistrationRequests()).toHaveLength(1);
    }

    await finishAuthorization(provider, issuer.resourceUrl, authorizationUrls[0]);

    const tokenRequest = issuer.getTokenRequests()[0];
    expect(tokenRequest?.client_id).toBe(clientId);
    expect(tokenRequest?.client_secret).toBeUndefined();
    expect(testOAuthStorage.data.get(issuer.resourceUrl)).toMatchObject({
      authorizationServerIssuer: issuer.authorizationServerUrl,
      tokens: { access_token: "access-1" },
    });
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: "access-1" });
  });

  it("keeps explicit client credentials ahead of CIMD and rejects a recorded issuer change", async () => {
    issuer.setCimdSupported(true);
    const nextIssuer = await startIssuer(true);
    const authorizationUrls: URL[] = [];
    const provider = createProvider(
      issuer,
      { clientId: "manual-client", clientSecret: "manual-secret" },
      (url) => authorizationUrls.push(new URL(url)),
    );

    expect(await auth(provider, { serverUrl: issuer.resourceUrl })).toBe("REDIRECT");
    expect(authorizationUrls[0].searchParams.get("client_id")).toBe("manual-client");
    expect(issuer.getRegistrationRequests()).toEqual([]);
    await finishAuthorization(provider, issuer.resourceUrl, authorizationUrls[0]);

    issuer.setAuthorizationServerUrl(nextIssuer.authorizationServerUrl);
    const changedProvider = createProvider(issuer, {
      clientId: "manual-client",
      clientSecret: "manual-secret",
    });

    await expect(auth(changedProvider, { serverUrl: issuer.resourceUrl })).rejects.toThrow(
      "bound to authorization server",
    );
    expect(nextIssuer.getRegistrationRequests()).toEqual([]);
    expect(nextIssuer.getTokenRequests()).toEqual([]);
  });

  it.each(["new", "after clearing unbound legacy credentials"] as const)(
    "persists the static client's issuer only after a successful token exchange (%s auth)",
    async (state) => {
      if (state === "after clearing unbound legacy credentials") {
        testOAuthStorage.data.set(issuer.resourceUrl, {
          serverUrl: issuer.resourceUrl,
          lastUpdated: Date.now(),
          clientInfo: { client_id: "legacy-client", client_secret: "legacy-secret" },
          tokens: {
            access_token: "legacy-access-token",
            token_type: "Bearer",
            refresh_token: "legacy-refresh-token",
          },
        });
      }

      const authorizationUrls: URL[] = [];
      const provider = createProvider(
        issuer,
        { clientId: "manual-client", clientSecret: "manual-secret" },
        (url) => authorizationUrls.push(new URL(url)),
      );

      expect(await auth(provider, { serverUrl: issuer.resourceUrl })).toBe("REDIRECT");
      expect(testOAuthStorage.data.get(issuer.resourceUrl)).toBeUndefined();

      await finishAuthorization(provider, issuer.resourceUrl, authorizationUrls[0]);

      expect(testOAuthStorage.data.get(issuer.resourceUrl)).toMatchObject({
        authorizationServerIssuer: issuer.authorizationServerUrl,
        clientInfo: { client_id: "manual-client", client_secret: "manual-secret" },
        tokens: { access_token: "access-1" },
      });
    },
  );

  it.each([
    {
      name: "configured credentials",
      config: { clientId: "static-refresh-client", clientSecret: "static-secret" },
      expectedClientId: "static-refresh-client",
    },
    {
      name: "advertised CIMD",
      config: {},
      expectedClientId: DEFAULT_CLIENT_METADATA_URL,
    },
  ])("refreshes at the discovered issuer with $name", async ({ config, expectedClientId }) => {
    issuer.setCimdSupported(true);
    testOAuthStorage.data.set(issuer.resourceUrl, {
      serverUrl: issuer.resourceUrl,
      lastUpdated: Date.now(),
      authorizationServerIssuer: issuer.authorizationServerUrl,
      tokens: {
        access_token: "expired-access-token",
        token_type: "Bearer",
        refresh_token: "valid-refresh-token",
        expires_at: Math.floor(Date.now() / 1000) - 10,
      },
    });

    const result = await ensureValidTokens(issuer.resourceUrl, config);

    expect(result.status).toBe("refreshed");
    expect(issuer.getTokenRequests()).toEqual([
      expect.objectContaining({
        grant_type: "refresh_token",
        client_id: expectedClientId,
        refresh_token: "valid-refresh-token",
        resource: issuer.resourceUrl,
      }),
    ]);
    expect(issuer.getRegistrationRequests()).toEqual([]);
    expect(testOAuthStorage.data.get(issuer.resourceUrl)?.tokens).toMatchObject({
      access_token: "access-1",
      refresh_token: "rotated-refresh-token",
    });
  });

  it("returns an issuer mismatch during refresh instead of sending a stored registration elsewhere", async () => {
    const nextIssuer = await startIssuer();
    testOAuthStorage.data.set(issuer.resourceUrl, {
      serverUrl: issuer.resourceUrl,
      lastUpdated: Date.now(),
      authorizationServerIssuer: issuer.authorizationServerUrl,
      clientInfo: { client_id: "issuer-one-client" },
      tokens: {
        access_token: "expired-access-token",
        token_type: "Bearer",
        refresh_token: "issuer-one-refresh-token",
        expires_at: Math.floor(Date.now() / 1000) - 10,
      },
    });
    issuer.setAuthorizationServerUrl(nextIssuer.authorizationServerUrl);

    const result = await ensureValidTokens(issuer.resourceUrl);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Stored OAuth client registration is bound");
    expect(nextIssuer.getTokenRequests()).toEqual([]);
  });

  it("requires re-authentication instead of refreshing legacy tokens without an issuer binding", async () => {
    testOAuthStorage.data.set(issuer.resourceUrl, {
      serverUrl: issuer.resourceUrl,
      lastUpdated: Date.now(),
      clientInfo: { client_id: "legacy-client", client_secret: "legacy-secret" },
      tokens: {
        access_token: "legacy-access-token",
        token_type: "Bearer",
        refresh_token: "legacy-refresh-token",
        expires_at: Math.floor(Date.now() / 1000) - 10,
      },
    });

    const result = await ensureValidTokens(issuer.resourceUrl);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("no authorization server binding"),
    });
    expect(issuer.getRequests()).toEqual([]);
  });
});
