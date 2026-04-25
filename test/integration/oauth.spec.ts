import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/oauth/storage.js", () => ({
  loadOAuthStorage: vi.fn(),
  saveTokens: vi.fn(),
  isTokenExpired: vi.fn(),
}));

import { ensureValidTokens, refreshAllTokens } from "../../src/oauth/refresh.js";
import type { OAuthStorageData } from "../../src/oauth/storage.js";
import { isTokenExpired, loadOAuthStorage, saveTokens } from "../../src/oauth/storage.js";
import { createMockOAuthServer, type MockOAuthServer } from "../helpers/mock-oauth-server.js";

describe("OAuth Refresh Integration", () => {
  let mockServer: MockOAuthServer;
  let serverUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockServer = await createMockOAuthServer({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 7200,
    });
    await mockServer.start();
    serverUrl = mockServer.baseUrl;
  });

  afterEach(async () => {
    await mockServer.stop();
    vi.restoreAllMocks();
  });

  function createStorageData(overrides: Partial<OAuthStorageData> = {}): OAuthStorageData {
    return {
      serverUrl,
      lastUpdated: Date.now(),
      ...overrides,
    };
  }

  describe("ensureValidTokens", () => {
    it("returns no-tokens when storage has no tokens", async () => {
      vi.mocked(loadOAuthStorage).mockResolvedValue(null);

      const result = await ensureValidTokens(serverUrl);

      expect(result).toEqual({ serverUrl, status: "no-tokens" });
    });

    it("returns valid when tokens are not expired", async () => {
      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          tokens: {
            access_token: "valid-token",
            token_type: "Bearer",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        }),
      );
      vi.mocked(isTokenExpired).mockReturnValue(false);

      const result = await ensureValidTokens(serverUrl);

      expect(result).toEqual({ serverUrl, status: "valid" });
    });

    it("returns expired when token is expired and no refresh token", async () => {
      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          tokens: {
            access_token: "expired-token",
            token_type: "Bearer",
            expires_at: Math.floor(Date.now() / 1000) - 3600,
          },
        }),
      );
      vi.mocked(isTokenExpired).mockImplementation((tokens, threshold) => {
        if (!tokens?.expires_at) return false;
        const now = Math.floor(Date.now() / 1000);
        return tokens.expires_at <= now + (threshold ?? 0);
      });

      const result = await ensureValidTokens(serverUrl);

      expect(result).toEqual({ serverUrl, status: "expired" });
    });

    it("refreshes token when approaching expiry with refresh token", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          clientInfo: {
            client_id: "mock-client-id",
            client_secret: "mock-client-secret",
          },
          tokens: {
            access_token: "old-token",
            token_type: "Bearer",
            refresh_token: "valid-refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 100,
          },
        }),
      );
      vi.mocked(isTokenExpired).mockImplementation((tokens, threshold) => {
        if (!tokens?.expires_at) return false;
        const now = Math.floor(Date.now() / 1000);
        return tokens.expires_at <= now + (threshold ?? 0);
      });

      const result = await ensureValidTokens(serverUrl);

      expect(result.status).toBe("refreshed");
      expect(saveTokens).toHaveBeenCalledWith(
        serverUrl,
        expect.objectContaining({
          access_token: "new-access-token-refreshed",
          token_type: "Bearer",
        }),
      );

      const tokenRequests = mockServer.getTokenRequests();
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].grantType).toBe("refresh_token");

      errorSpy.mockRestore();
    });

    it("returns error when no client info for refresh", async () => {
      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          tokens: {
            access_token: "old-token",
            token_type: "Bearer",
            refresh_token: "valid-refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 100,
          },
        }),
      );
      vi.mocked(isTokenExpired).mockReturnValue(true);

      const result = await ensureValidTokens(serverUrl);

      expect(result.status).toBe("error");
      expect(result.error).toContain("No client info");
    });

    it("preserves old refresh token if new one not returned", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          clientInfo: {
            client_id: "mock-client-id",
          },
          tokens: {
            access_token: "old-token",
            token_type: "Bearer",
            refresh_token: "original-refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 100,
          },
        }),
      );
      vi.mocked(isTokenExpired).mockReturnValue(true);

      await ensureValidTokens(serverUrl);

      expect(saveTokens).toHaveBeenCalledWith(
        serverUrl,
        expect.objectContaining({
          refresh_token: expect.any(String),
        }),
      );

      errorSpy.mockRestore();
    });
  });

  describe("refreshAllTokens", () => {
    it("refreshes tokens for all servers with OAuth config", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          clientInfo: { client_id: "client" },
          tokens: {
            access_token: "old",
            token_type: "Bearer",
            refresh_token: "refresh",
            expires_at: Math.floor(Date.now() / 1000) + 100,
          },
        }),
      );
      vi.mocked(isTokenExpired).mockReturnValue(true);

      const servers = new Map([
        ["server1", { url: serverUrl, oauth: {} }],
        ["server2", { url: `${serverUrl}/other`, oauth: {} }],
        ["no-oauth", { url: serverUrl }],
      ]);

      const results = await refreshAllTokens(servers);

      expect(results.length).toBe(2);

      errorSpy.mockRestore();
    });

    it("skips servers without url", async () => {
      const servers = new Map([["no-url", { oauth: {} }]]);

      const results = await refreshAllTokens(servers);

      expect(results).toHaveLength(0);
    });

    it("skips servers without oauth config", async () => {
      const servers = new Map([["no-oauth", { url: serverUrl }]]);

      const results = await refreshAllTokens(servers);

      expect(results).toHaveLength(0);
    });
  });
});

describe("Mock OAuth Server", () => {
  let mockServer: MockOAuthServer;

  beforeEach(async () => {
    mockServer = await createMockOAuthServer();
    await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
  });

  it("serves OAuth metadata at well-known endpoint", async () => {
    const response = await fetch(`${mockServer.baseUrl}/.well-known/oauth-authorization-server`);
    const metadata = await response.json();

    expect(response.status).toBe(200);
    expect(metadata.issuer).toBe(mockServer.baseUrl);
    expect(metadata.authorization_endpoint).toContain("/authorize");
    expect(metadata.token_endpoint).toContain("/token");
    expect(metadata.registration_endpoint).toContain("/register");
  });

  it("handles dynamic client registration", async () => {
    const response = await fetch(`${mockServer.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: ["http://localhost/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await response.json();

    expect(response.status).toBe(201);
    expect(client.client_id).toBeDefined();
    expect(client.client_name).toBe("Test Client");
    expect(client.redirect_uris).toEqual(["http://localhost/callback"]);

    const registrations = mockServer.getRegistrationRequests();
    expect(registrations).toHaveLength(1);
    expect(registrations[0].clientName).toBe("Test Client");
  });

  it("exchanges authorization code for tokens", async () => {
    const formData = new FormData();
    formData.append("grant_type", "authorization_code");
    formData.append("code", "test-code");
    formData.append("client_id", "test-client");

    const response = await fetch(`${mockServer.baseUrl}/token`, {
      method: "POST",
      body: formData,
    });
    const tokens = await response.json();

    expect(response.status).toBe(200);
    expect(tokens.access_token).toBeDefined();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeDefined();

    const tokenRequests = mockServer.getTokenRequests();
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].grantType).toBe("authorization_code");
    expect(tokenRequests[0].code).toBe("test-code");
  });

  it("refreshes tokens with refresh_token grant", async () => {
    const formData = new FormData();
    formData.append("grant_type", "refresh_token");
    formData.append("refresh_token", "test-refresh");

    const response = await fetch(`${mockServer.baseUrl}/token`, {
      method: "POST",
      body: formData,
    });
    const tokens = await response.json();

    expect(response.status).toBe(200);
    expect(tokens.access_token).toContain("-refreshed");

    const tokenRequests = mockServer.getTokenRequests();
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].grantType).toBe("refresh_token");
  });

  it("rejects unsupported grant types", async () => {
    const formData = new FormData();
    formData.append("grant_type", "password");

    const response = await fetch(`${mockServer.baseUrl}/token`, {
      method: "POST",
      body: formData,
    });
    const error = await response.json();

    expect(response.status).toBe(400);
    expect(error.error).toBe("unsupported_grant_type");
  });

  it("redirects authorization request with code", async () => {
    const response = await fetch(
      `${mockServer.baseUrl}/authorize?client_id=test&redirect_uri=http://localhost/cb&state=xyz`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toContain("code=mock-authorization-code");
    expect(location).toContain("state=xyz");
  });

  it("returns 404 for unknown endpoints", async () => {
    const response = await fetch(`${mockServer.baseUrl}/unknown`);

    expect(response.status).toBe(404);
  });

  it("accepts custom configuration", async () => {
    await mockServer.stop();

    const customServer = await createMockOAuthServer({
      accessToken: "custom-token",
      expiresIn: 1800,
    });
    await customServer.start();

    const formData = new FormData();
    formData.append("grant_type", "authorization_code");
    formData.append("code", "code");

    const response = await fetch(`${customServer.baseUrl}/token`, {
      method: "POST",
      body: formData,
    });
    const tokens = await response.json();

    expect(tokens.access_token).toBe("custom-token");
    expect(tokens.expires_in).toBe(1800);

    await customServer.stop();
  });
});
