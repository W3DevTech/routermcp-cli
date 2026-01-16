import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:net", () => ({
  createServer: vi.fn(() => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
        setTimeout(() => callback?.(), 0);
      }),
      address: vi.fn(() => ({ port: 54321 })),
      close: vi.fn((callback?: () => void) => callback?.()),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(listener);
      }),
    };
  }),
}));

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { createServer } from "node:net";
import type { FetchHandler, ServeOptions, ServerHandle } from "../../../src/compat/index.js";
import { serve } from "../../../src/compat/index.js";
import {
  type OAuthCallbackServer,
  createOAuthCallbackServer,
} from "../../../src/oauth/callback-server.js";

describe("createOAuthCallbackServer", () => {
  let mockServeHandle: ServerHandle;
  let capturedFetch: FetchHandler | null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedFetch = null;

    mockServeHandle = {
      stop: vi.fn(),
      port: 54321,
    };

    vi.mocked(serve).mockImplementation((options: ServeOptions): ServerHandle => {
      capturedFetch = options.fetch;
      return mockServeHandle;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("server creation", () => {
    it("finds available port via temporary TCP server", async () => {
      const server = await createOAuthCallbackServer();

      expect(createServer).toHaveBeenCalled();
      expect(server.port).toBe(54321);
    });

    it("generates callback URL with discovered port", async () => {
      const server = await createOAuthCallbackServer();

      expect(server.callbackUrl).toBe("http://127.0.0.1:54321/oauth/callback");
    });

    it("returns OAuthCallbackServer interface", async () => {
      const server = await createOAuthCallbackServer();

      expect(server).toHaveProperty("port");
      expect(server).toHaveProperty("callbackUrl");
      expect(server).toHaveProperty("start");
      expect(server).toHaveProperty("waitForCallback");
      expect(server).toHaveProperty("stop");
    });
  });

  describe("start", () => {
    it("starts HTTP server with correct port", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();

      expect(serve).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 54321,
        }),
      );
    });

    it("registers fetch handler", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();

      expect(capturedFetch).toBeDefined();
      expect(typeof capturedFetch).toBe("function");
    });
  });

  describe("stop", () => {
    it("stops the HTTP server", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();
      await server.stop();

      expect(mockServeHandle.stop).toHaveBeenCalled();
    });

    it("handles stop when server not started", async () => {
      const server = await createOAuthCallbackServer();
      await server.stop();

      expect(mockServeHandle.stop).not.toHaveBeenCalled();
    });
  });

  describe("fetch handler", () => {
    let server: OAuthCallbackServer;

    beforeEach(async () => {
      server = await createOAuthCallbackServer();
      await server.start();
    });

    it("returns 404 for non-callback paths", async () => {
      const request = new Request("http://127.0.0.1:54321/other/path");
      const response = await capturedFetch!(request);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    it("handles successful callback with code", async () => {
      const callbackPromise = server.waitForCallback();

      const request = new Request(
        "http://127.0.0.1:54321/oauth/callback?code=auth123&state=mystate",
      );
      const response = await capturedFetch!(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");

      const result = await callbackPromise;
      expect(result.code).toBe("auth123");
      expect(result.state).toBe("mystate");
    });

    it("handles callback with code but no state", async () => {
      const callbackPromise = server.waitForCallback();

      const request = new Request("http://127.0.0.1:54321/oauth/callback?code=nostate");
      const response = await capturedFetch!(request);

      expect(response.status).toBe(200);

      const result = await callbackPromise;
      expect(result.code).toBe("nostate");
      expect(result.state).toBeUndefined();
    });

    it("handles OAuth error response", async () => {
      const callbackPromise = server.waitForCallback();

      const request = new Request(
        "http://127.0.0.1:54321/oauth/callback?error=access_denied&error_description=User%20denied",
      );
      const response = await capturedFetch!(request);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Authorization Failed");
      expect(html).toContain("User denied");

      await expect(callbackPromise).rejects.toThrow("OAuth error: User denied");
    });

    it("uses error code when no error_description", async () => {
      const callbackPromise = server.waitForCallback();

      const request = new Request("http://127.0.0.1:54321/oauth/callback?error=server_error");
      const response = await capturedFetch!(request);

      expect(response.status).toBe(200);

      await expect(callbackPromise).rejects.toThrow("OAuth error: server_error");
    });

    it("handles missing authorization code", async () => {
      const callbackPromise = server.waitForCallback();

      const request = new Request("http://127.0.0.1:54321/oauth/callback");
      const response = await capturedFetch!(request);

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Missing authorization code");

      await expect(callbackPromise).rejects.toThrow("Missing authorization code");
    });

    it("returns success HTML on valid callback", async () => {
      const callbackPromise = server.waitForCallback();

      const request = new Request("http://127.0.0.1:54321/oauth/callback?code=valid");
      const response = await capturedFetch!(request);

      const html = await response.text();
      expect(html).toContain("Authorization Successful");
      expect(html).toContain("close this tab");

      await callbackPromise;
    });
  });

  describe("waitForCallback", () => {
    it("resolves with callback result", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();

      const callbackPromise = server.waitForCallback();
      await capturedFetch!(new Request("http://127.0.0.1:54321/oauth/callback?code=test"));

      const result = await callbackPromise;
      expect(result.code).toBe("test");
    });

    it("times out after specified duration", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();

      const callbackPromise = server.waitForCallback(50);

      await expect(callbackPromise).rejects.toThrow("Authorization timed out");
    }, 1000);

    it("clears pending handlers on success", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();

      const callbackPromise = server.waitForCallback();
      await capturedFetch!(new Request("http://127.0.0.1:54321/oauth/callback?code=first"));
      await callbackPromise;

      const secondRequest = new Request("http://127.0.0.1:54321/oauth/callback?code=second");
      const response = await capturedFetch!(secondRequest);
      expect(response.status).toBe(200);
    });

    it("clears pending handlers on error", async () => {
      const server = await createOAuthCallbackServer();
      await server.start();

      const callbackPromise = server.waitForCallback();
      await capturedFetch!(new Request("http://127.0.0.1:54321/oauth/callback?error=failed"));

      await expect(callbackPromise).rejects.toThrow();

      const secondRequest = new Request("http://127.0.0.1:54321/oauth/callback?code=retry");
      const response = await capturedFetch!(secondRequest);
      expect(response.status).toBe(200);
    });
  });

  describe("port discovery error handling", () => {
    it("handles port discovery failure", async () => {
      const mockServer = {
        listen: vi.fn(),
        address: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event: string, callback: (err: Error) => void) => {
          if (event === "error") {
            setTimeout(() => callback(new Error("EADDRINUSE")), 0);
          }
        }),
      };
      vi.mocked(createServer).mockReturnValueOnce(
        mockServer as unknown as ReturnType<typeof createServer>,
      );

      await expect(createOAuthCallbackServer()).rejects.toThrow("EADDRINUSE");
    });

    it("handles address() returning non-object", async () => {
      const mockServer = {
        listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
          setTimeout(() => callback?.(), 0);
        }),
        address: vi.fn(() => null),
        close: vi.fn((callback?: () => void) => callback?.()),
        on: vi.fn(),
      };
      vi.mocked(createServer).mockReturnValueOnce(
        mockServer as unknown as ReturnType<typeof createServer>,
      );

      await expect(createOAuthCallbackServer()).rejects.toThrow("Failed to get port");
    });
  });
});
