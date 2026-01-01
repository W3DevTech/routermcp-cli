import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/oauth/storage.js", () => ({
  loadOAuthStorage: vi.fn(),
  saveOAuthStorage: vi.fn(),
  isClientSecretExpired: vi.fn(),
}));

vi.mock("../../../src/oauth/callback-server.js", () => ({
  createOAuthCallbackServer: vi.fn(),
}));

import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createOAuthCallbackServer } from "../../../src/oauth/callback-server.js";
import {
  DEFAULT_CLIENT_NAME,
  RouterMcpOAuthProvider,
  createOAuthProvider,
  type OAuthProviderCallbacks,
  type OAuthProviderConfig,
} from "../../../src/oauth/provider.js";
import {
  type OAuthStorageData,
  isClientSecretExpired,
  loadOAuthStorage,
  saveOAuthStorage,
} from "../../../src/oauth/storage.js";

describe("RouterMcpOAuthProvider", () => {
  const mockServerName = "test-server";
  const mockServerUrl = "https://api.example.com/mcp";

  let mockCallbacks: OAuthProviderCallbacks;
  let mockCallbackServer: ReturnType<typeof createMockCallbackServer>;

  function createMockCallbackServer() {
    return {
      port: 12345,
      callbackUrl: "http://127.0.0.1:12345/oauth/callback",
      start: vi.fn().mockResolvedValue(undefined),
      waitForCallback: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createStorageData(overrides: Partial<OAuthStorageData> = {}): OAuthStorageData {
    return {
      serverUrl: mockServerUrl,
      lastUpdated: Date.now(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallbacks = {
      onAuthorizationUrl: vi.fn(),
      onAuthorizationComplete: vi.fn(),
      onError: vi.fn(),
    };

    mockCallbackServer = createMockCallbackServer();
    vi.mocked(createOAuthCallbackServer).mockResolvedValue(mockCallbackServer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor and basic properties", () => {
    it("creates provider with required parameters", () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider).toBeInstanceOf(RouterMcpOAuthProvider);
    });

    it("returns default redirect URL when no callback server", () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.redirectUrl).toBe("http://127.0.0.1:0/oauth/callback");
    });
  });

  describe("clientMetadata", () => {
    it("returns basic metadata with default client name", () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const metadata = provider.clientMetadata;

      expect(metadata).toEqual({
        redirect_uris: ["http://127.0.0.1:0/oauth/callback"],
        client_name: DEFAULT_CLIENT_NAME,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    });

    it("uses custom client name when provided", () => {
      const config: OAuthProviderConfig = { clientName: "Custom CLI" };
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.clientMetadata.client_name).toBe("Custom CLI");
    });

    it("sets token_endpoint_auth_method to client_secret_post when clientSecret provided", () => {
      const config: OAuthProviderConfig = { clientSecret: "secret123" };
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
    });

    it("includes scope when scopes are configured", () => {
      const config: OAuthProviderConfig = { scopes: ["read", "write", "admin"] };
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.clientMetadata.scope).toBe("read write admin");
    });

    it("does not include scope when scopes is empty array", () => {
      const config: OAuthProviderConfig = { scopes: [] };
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.clientMetadata.scope).toBeUndefined();
    });

    it("does not include scope when scopes is undefined", () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.clientMetadata.scope).toBeUndefined();
    });

    it("uses callback server URL when server is started", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.startCallbackServer();

      expect(provider.clientMetadata.redirect_uris).toEqual([mockCallbackServer.callbackUrl]);
    });
  });

  describe("clientInformation", () => {
    it("returns config clientId and clientSecret when provided", async () => {
      const config: OAuthProviderConfig = {
        clientId: "config-client",
        clientSecret: "config-secret",
      };
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const info = await provider.clientInformation();

      expect(info).toEqual({
        client_id: "config-client",
        client_secret: "config-secret",
      });
      expect(loadOAuthStorage).not.toHaveBeenCalled();
    });

    it("returns pending client info when available", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const fullInfo: OAuthClientInformationFull = {
        redirect_uris: ["http://127.0.0.1:0/oauth/callback"],
        client_id: "pending-client",
        client_secret: "pending-secret",
        client_id_issued_at: 1234567890,
        client_secret_expires_at: 9999999999,
      };
      await provider.saveClientInformation(fullInfo);

      const info = await provider.clientInformation();

      expect(info).toEqual({
        client_id: "pending-client",
        client_secret: "pending-secret",
      });
    });

    it("loads from storage when no config or pending info", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          clientInfo: {
            client_id: "stored-client",
            client_secret: "stored-secret",
          },
        }),
      );
      vi.mocked(isClientSecretExpired).mockReturnValue(false);

      const info = await provider.clientInformation();

      expect(loadOAuthStorage).toHaveBeenCalledWith(mockServerUrl);
      expect(info).toEqual({
        client_id: "stored-client",
        client_secret: "stored-secret",
      });
    });

    it("returns undefined when no stored client info", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(null);

      const info = await provider.clientInformation();

      expect(info).toBeUndefined();
    });

    it("returns undefined when stored info has no clientInfo", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(createStorageData({ tokens: undefined }));

      const info = await provider.clientInformation();

      expect(info).toBeUndefined();
    });

    it("returns undefined when client secret is expired", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          clientInfo: {
            client_id: "expired-client",
            client_secret: "expired-secret",
            client_secret_expires_at: 1000,
          },
        }),
      );
      vi.mocked(isClientSecretExpired).mockReturnValue(true);

      const info = await provider.clientInformation();

      expect(info).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Client secret expired"));

      errorSpy.mockRestore();
    });
  });

  describe("saveClientInformation", () => {
    it("stores client info as pending", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const fullInfo: OAuthClientInformationFull = {
        redirect_uris: ["http://127.0.0.1:0/oauth/callback"],
        client_id: "new-client",
        client_secret: "new-secret",
        client_id_issued_at: 1234567890,
        client_secret_expires_at: 9999999999,
      };

      await provider.saveClientInformation(fullInfo);

      const info = await provider.clientInformation();
      expect(info).toEqual({
        client_id: "new-client",
        client_secret: "new-secret",
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Client registered"));

      errorSpy.mockRestore();
    });

    it("logs pending token exchange message", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await provider.saveClientInformation({
        redirect_uris: ["http://127.0.0.1:0/oauth/callback"],
        client_id: "test",
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("pending token exchange"));

      errorSpy.mockRestore();
    });
  });

  describe("tokens", () => {
    it("returns undefined when no stored tokens", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(null);

      const tokens = await provider.tokens();

      expect(tokens).toBeUndefined();
    });

    it("returns undefined when stored data has no tokens", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(createStorageData({ clientInfo: undefined }));

      const tokens = await provider.tokens();

      expect(tokens).toBeUndefined();
    });

    it("returns tokens with calculated expires_in", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const futureTime = Math.floor(Date.now() / 1000) + 3600;
      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          tokens: {
            access_token: "access123",
            token_type: "Bearer",
            refresh_token: "refresh456",
            expires_at: futureTime,
            scope: "read write",
          },
        }),
      );

      const tokens = await provider.tokens();

      expect(tokens).toBeDefined();
      expect(tokens!.access_token).toBe("access123");
      expect(tokens!.token_type).toBe("Bearer");
      expect(tokens!.refresh_token).toBe("refresh456");
      expect(tokens!.scope).toBe("read write");
      expect(tokens!.expires_in).toBeGreaterThan(3500);
      expect(tokens!.expires_in).toBeLessThanOrEqual(3600);
    });

    it("returns 0 for expires_in when token is expired", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const pastTime = Math.floor(Date.now() / 1000) - 3600;
      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          tokens: {
            access_token: "expired",
            token_type: "Bearer",
            expires_at: pastTime,
          },
        }),
      );

      const tokens = await provider.tokens();

      expect(tokens!.expires_in).toBe(0);
    });

    it("returns undefined expires_in when no expires_at", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({
          tokens: {
            access_token: "no-expiry",
            token_type: "Bearer",
          },
        }),
      );

      const tokens = await provider.tokens();

      expect(tokens!.expires_in).toBeUndefined();
    });
  });

  describe("saveTokens", () => {
    it("saves tokens with calculated expires_at", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const tokens: OAuthTokens = {
        access_token: "new-access",
        token_type: "Bearer",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "read",
      };

      const beforeSave = Math.floor(Date.now() / 1000);
      await provider.saveTokens(tokens);
      const afterSave = Math.floor(Date.now() / 1000);

      expect(saveOAuthStorage).toHaveBeenCalledWith(mockServerUrl, {
        clientInfo: undefined,
        tokens: {
          access_token: "new-access",
          token_type: "Bearer",
          refresh_token: "new-refresh",
          expires_at: expect.any(Number),
          scope: "read",
        },
      });

      const savedCall = vi.mocked(saveOAuthStorage).mock.calls[0][1];
      expect(savedCall.tokens!.expires_at).toBeGreaterThanOrEqual(beforeSave + 3600);
      expect(savedCall.tokens!.expires_at).toBeLessThanOrEqual(afterSave + 3600);

      errorSpy.mockRestore();
    });

    it("saves tokens without expires_at when no expires_in", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const tokens: OAuthTokens = {
        access_token: "no-expiry",
        token_type: "Bearer",
      };

      await provider.saveTokens(tokens);

      expect(saveOAuthStorage).toHaveBeenCalledWith(mockServerUrl, {
        clientInfo: undefined,
        tokens: {
          access_token: "no-expiry",
          token_type: "Bearer",
          refresh_token: undefined,
          expires_at: undefined,
          scope: undefined,
        },
      });

      errorSpy.mockRestore();
    });

    it("includes pending client info when saving tokens", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await provider.saveClientInformation({
        redirect_uris: ["http://127.0.0.1:0/oauth/callback"],
        client_id: "pending-client",
        client_secret: "pending-secret",
      });

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      });

      expect(saveOAuthStorage).toHaveBeenCalledWith(mockServerUrl, {
        clientInfo: {
          client_id: "pending-client",
          client_secret: "pending-secret",
          client_id_issued_at: undefined,
          client_secret_expires_at: undefined,
        },
        tokens: expect.any(Object),
      });

      errorSpy.mockRestore();
    });

    it("logs saved credentials message", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Saved credentials"));

      errorSpy.mockRestore();
    });
  });

  describe("redirectToAuthorization", () => {
    it("creates and starts callback server on first call", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const authUrl = new URL("https://auth.example.com/authorize");

      await provider.redirectToAuthorization(authUrl);

      expect(createOAuthCallbackServer).toHaveBeenCalled();
      expect(mockCallbackServer.start).toHaveBeenCalled();
    });

    it("updates redirect_uri in authorization URL", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const authUrl = new URL("https://auth.example.com/authorize?client_id=test");

      await provider.redirectToAuthorization(authUrl);

      expect(authUrl.searchParams.get("redirect_uri")).toBe(mockCallbackServer.callbackUrl);
    });

    it("calls onAuthorizationUrl callback with URL", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const authUrl = new URL("https://auth.example.com/authorize");

      await provider.redirectToAuthorization(authUrl);

      expect(mockCallbacks.onAuthorizationUrl).toHaveBeenCalledWith(authUrl);
    });

    it("sets up callback promise for waitForAuthorizationCode", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      mockCallbackServer.waitForCallback.mockResolvedValue({ code: "auth-code" });

      const authUrl = new URL("https://auth.example.com/authorize");
      await provider.redirectToAuthorization(authUrl);

      expect(mockCallbackServer.waitForCallback).toHaveBeenCalled();
    });

    it("reuses existing callback server on subsequent calls", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const authUrl1 = new URL("https://auth.example.com/authorize1");
      const authUrl2 = new URL("https://auth.example.com/authorize2");

      await provider.redirectToAuthorization(authUrl1);
      await provider.redirectToAuthorization(authUrl2);

      expect(createOAuthCallbackServer).toHaveBeenCalledTimes(1);
      expect(mockCallbackServer.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("waitForAuthorizationCode", () => {
    it("returns authorization code on success", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      mockCallbackServer.waitForCallback.mockResolvedValue({
        code: "success-code",
        state: "state123",
      });

      const authUrl = new URL("https://auth.example.com/authorize");
      await provider.redirectToAuthorization(authUrl);

      const code = await provider.waitForAuthorizationCode();

      expect(code).toBe("success-code");
      expect(mockCallbacks.onAuthorizationComplete).toHaveBeenCalled();
    });

    it("throws error when no pending authorization", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await expect(provider.waitForAuthorizationCode()).rejects.toThrow("No pending authorization");
    });

    it("calls onError callback on failure", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const error = new Error("Callback failed");
      mockCallbackServer.waitForCallback.mockRejectedValue(error);

      const authUrl = new URL("https://auth.example.com/authorize");
      await provider.redirectToAuthorization(authUrl);

      await expect(provider.waitForAuthorizationCode()).rejects.toThrow("Callback failed");
      expect(mockCallbacks.onError).toHaveBeenCalledWith(error);
    });

    it("wraps non-Error objects in Error", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      mockCallbackServer.waitForCallback.mockRejectedValue("string error");

      const authUrl = new URL("https://auth.example.com/authorize");
      await provider.redirectToAuthorization(authUrl);

      await expect(provider.waitForAuthorizationCode()).rejects.toThrow("string error");
      expect(mockCallbacks.onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it("clears callback promise after completion", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      mockCallbackServer.waitForCallback.mockResolvedValue({ code: "code" });

      const authUrl = new URL("https://auth.example.com/authorize");
      await provider.redirectToAuthorization(authUrl);
      await provider.waitForAuthorizationCode();

      await expect(provider.waitForAuthorizationCode()).rejects.toThrow("No pending authorization");
    });

    it("stores authorization code for later retrieval", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      mockCallbackServer.waitForCallback.mockResolvedValue({ code: "stored-code" });

      const authUrl = new URL("https://auth.example.com/authorize");
      await provider.redirectToAuthorization(authUrl);
      await provider.waitForAuthorizationCode();

      expect(provider.getAuthorizationCode()).toBe("stored-code");
    });
  });

  describe("getAuthorizationCode", () => {
    it("returns null when no authorization completed", () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.getAuthorizationCode()).toBeNull();
    });
  });

  describe("saveCodeVerifier and codeVerifier", () => {
    it("saves and retrieves code verifier", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.saveCodeVerifier("test-verifier-123");

      const verifier = await provider.codeVerifier();

      expect(verifier).toBe("test-verifier-123");
    });

    it("falls back to storage when no in-memory verifier", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(
        createStorageData({ codeVerifier: "stored-verifier" }),
      );

      const verifier = await provider.codeVerifier();

      expect(verifier).toBe("stored-verifier");
    });

    it("throws error when no verifier available", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(null);

      await expect(provider.codeVerifier()).rejects.toThrow(
        `No code verifier saved for ${mockServerName}`,
      );
    });

    it("throws error when storage has no codeVerifier", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      vi.mocked(loadOAuthStorage).mockResolvedValue(createStorageData({ tokens: undefined }));

      await expect(provider.codeVerifier()).rejects.toThrow(
        `No code verifier saved for ${mockServerName}`,
      );
    });
  });

  describe("startCallbackServer", () => {
    it("creates and starts callback server", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      const url = await provider.startCallbackServer();

      expect(createOAuthCallbackServer).toHaveBeenCalled();
      expect(mockCallbackServer.start).toHaveBeenCalled();
      expect(url).toBe(mockCallbackServer.callbackUrl);
    });

    it("reuses existing server on subsequent calls", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.startCallbackServer();
      await provider.startCallbackServer();

      expect(createOAuthCallbackServer).toHaveBeenCalledTimes(1);
    });
  });

  describe("stopCallbackServer", () => {
    it("stops the callback server", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.startCallbackServer();
      await provider.stopCallbackServer();

      expect(mockCallbackServer.stop).toHaveBeenCalled();
    });

    it("does nothing when no server running", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.stopCallbackServer();

      expect(mockCallbackServer.stop).not.toHaveBeenCalled();
    });

    it("clears server reference after stopping", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.startCallbackServer();
      await provider.stopCallbackServer();

      expect(provider.getCallbackUrl()).toBeNull();
    });
  });

  describe("getCallbackUrl", () => {
    it("returns null when no server", () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      expect(provider.getCallbackUrl()).toBeNull();
    });

    it("returns callback URL when server running", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.startCallbackServer();

      expect(provider.getCallbackUrl()).toBe(mockCallbackServer.callbackUrl);
    });
  });

  describe("redirectUrl getter", () => {
    it("returns callback server URL when running", async () => {
      const config: OAuthProviderConfig = {};
      const provider = new RouterMcpOAuthProvider(
        mockServerName,
        mockServerUrl,
        config,
        mockCallbacks,
      );

      await provider.startCallbackServer();

      expect(provider.redirectUrl).toBe(mockCallbackServer.callbackUrl);
    });
  });
});

describe("createOAuthProvider factory", () => {
  it("creates RouterMcpOAuthProvider instance", () => {
    const callbacks: OAuthProviderCallbacks = {
      onAuthorizationUrl: vi.fn(),
      onAuthorizationComplete: vi.fn(),
      onError: vi.fn(),
    };

    const provider = createOAuthProvider("server", "https://example.com", {}, callbacks);

    expect(provider).toBeInstanceOf(RouterMcpOAuthProvider);
  });

  it("passes all parameters to constructor", () => {
    const config: OAuthProviderConfig = {
      clientId: "test-id",
      clientSecret: "test-secret",
      scopes: ["read"],
      clientName: "Test Client",
    };
    const callbacks: OAuthProviderCallbacks = {
      onAuthorizationUrl: vi.fn(),
      onAuthorizationComplete: vi.fn(),
      onError: vi.fn(),
    };

    const provider = createOAuthProvider("my-server", "https://api.test.com", config, callbacks);

    expect(provider.clientMetadata.client_name).toBe("Test Client");
    expect(provider.clientMetadata.scope).toBe("read");
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });
});

describe("DEFAULT_CLIENT_NAME export", () => {
  it("equals 'RouterMCP'", () => {
    expect(DEFAULT_CLIENT_NAME).toBe("RouterMCP");
  });
});
