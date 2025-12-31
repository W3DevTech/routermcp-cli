import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/proxy/index.js", () => ({
  startSseProxy: vi.fn().mockResolvedValue(undefined),
  startStreamableHttpProxy: vi.fn().mockResolvedValue(undefined),
  DEFAULT_PROXY_OPTIONS: {
    port: 8000,
    outputTransport: "sse",
    basePath: "",
    ssePath: "/sse",
    messagePath: "/message",
    streamableHttpPath: "/mcp",
    stateful: false,
    sessionTimeout: 60000,
    healthEndpoint: "/health",
    cors: true,
    verbose: false,
    maxRestarts: 3,
  },
}));

import { proxyCommand, type ProxyCommandOptions } from "../../../src/cli/proxy.js";
import { startSseProxy, startStreamableHttpProxy } from "../../../src/proxy/index.js";

describe("proxyCommand", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("required options validation", () => {
    it("fails when --stdio is not provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(proxyCommand({})).rejects.toThrow("process.exit called");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--stdio is required"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it("shows example usage when --stdio is missing", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(proxyCommand({})).rejects.toThrow("process.exit called");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Example:"),
      );

      exitSpy.mockRestore();
    });
  });

  describe("transport selection", () => {
    it("uses SSE transport by default", async () => {
      await proxyCommand({ stdio: "echo test" });

      expect(startSseProxy).toHaveBeenCalled();
      expect(startStreamableHttpProxy).not.toHaveBeenCalled();
    });

    it("uses SSE transport when explicitly specified", async () => {
      await proxyCommand({ stdio: "echo test", outputTransport: "sse" });

      expect(startSseProxy).toHaveBeenCalled();
      expect(startStreamableHttpProxy).not.toHaveBeenCalled();
    });

    it("uses streamableHttp transport when specified", async () => {
      await proxyCommand({ stdio: "echo test", outputTransport: "streamableHttp" });

      expect(startStreamableHttpProxy).toHaveBeenCalled();
      expect(startSseProxy).not.toHaveBeenCalled();
    });
  });

  describe("option defaults", () => {
    it("uses default port 8000", async () => {
      await proxyCommand({ stdio: "echo test" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ port: 8000 }),
      );
    });

    it("uses default paths", async () => {
      await proxyCommand({ stdio: "echo test" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: "",
          ssePath: "/sse",
          messagePath: "/message",
          streamableHttpPath: "/mcp",
          healthEndpoint: "/health",
        }),
      );
    });

    it("enables CORS by default", async () => {
      await proxyCommand({ stdio: "echo test" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ cors: true }),
      );
    });

    it("sets stateful to false by default", async () => {
      await proxyCommand({ stdio: "echo test" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ stateful: false }),
      );
    });
  });

  describe("custom options", () => {
    it("uses custom port", async () => {
      await proxyCommand({ stdio: "echo test", port: 3000 });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ port: 3000 }),
      );
    });

    it("uses custom base path", async () => {
      await proxyCommand({ stdio: "echo test", basePath: "/api/v1" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ basePath: "/api/v1" }),
      );
    });

    it("uses custom SSE path", async () => {
      await proxyCommand({ stdio: "echo test", ssePath: "/events" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ ssePath: "/events" }),
      );
    });

    it("uses custom message path", async () => {
      await proxyCommand({ stdio: "echo test", messagePath: "/send" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ messagePath: "/send" }),
      );
    });

    it("uses custom streamable HTTP path", async () => {
      await proxyCommand({
        stdio: "echo test",
        outputTransport: "streamableHttp",
        streamableHttpPath: "/api/mcp",
      });

      expect(startStreamableHttpProxy).toHaveBeenCalledWith(
        expect.objectContaining({ streamableHttpPath: "/api/mcp" }),
      );
    });

    it("uses custom health endpoint", async () => {
      await proxyCommand({ stdio: "echo test", healthEndpoint: "/ping" });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ healthEndpoint: "/ping" }),
      );
    });

    it("enables stateful mode", async () => {
      await proxyCommand({
        stdio: "echo test",
        outputTransport: "streamableHttp",
        stateful: true,
      });

      expect(startStreamableHttpProxy).toHaveBeenCalledWith(
        expect.objectContaining({ stateful: true }),
      );
    });

    it("uses custom session timeout", async () => {
      await proxyCommand({
        stdio: "echo test",
        outputTransport: "streamableHttp",
        stateful: true,
        sessionTimeout: 120000,
      });

      expect(startStreamableHttpProxy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionTimeout: 120000 }),
      );
    });

    it("uses custom max restarts", async () => {
      await proxyCommand({ stdio: "echo test", maxRestarts: 5 });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ maxRestarts: 5 }),
      );
    });
  });

  describe("CORS handling", () => {
    it("disables CORS with --no-cors flag", async () => {
      await proxyCommand({ stdio: "echo test", noCors: true });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ cors: false }),
      );
    });

    it("enables CORS with --cors flag", async () => {
      await proxyCommand({ stdio: "echo test", cors: true });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ cors: true }),
      );
    });

    it("--no-cors takes precedence over --cors", async () => {
      await proxyCommand({ stdio: "echo test", cors: true, noCors: true });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ cors: false }),
      );
    });
  });

  describe("verbose mode", () => {
    it("logs configuration in verbose mode", async () => {
      await proxyCommand({ stdio: "echo test", verbose: true });

      expect(consoleErrorSpy).toHaveBeenCalledWith("Proxy configuration:");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Command: echo test"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Transport: sse"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Port: 8000"),
      );
    });

    it("logs SSE-specific paths in verbose mode with SSE transport", async () => {
      await proxyCommand({ stdio: "echo test", verbose: true, outputTransport: "sse" });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("SSE path:"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Message path:"),
      );
    });

    it("logs streamableHttp-specific options in verbose mode", async () => {
      await proxyCommand({
        stdio: "echo test",
        verbose: true,
        outputTransport: "streamableHttp",
        stateful: true,
        sessionTimeout: 60000,
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("MCP path:"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Stateful: true"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Session timeout: 60000ms"),
      );
    });

    it("does not log session timeout when not stateful", async () => {
      await proxyCommand({
        stdio: "echo test",
        verbose: true,
        outputTransport: "streamableHttp",
        stateful: false,
      });

      const sessionTimeoutCalls = consoleErrorSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Session timeout"),
      );
      expect(sessionTimeoutCalls).toHaveLength(0);
    });

    it("passes verbose flag to proxy options", async () => {
      await proxyCommand({ stdio: "echo test", verbose: true });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ verbose: true }),
      );
    });
  });

  describe("command passthrough", () => {
    it("passes stdio command to proxy", async () => {
      const command = "npx -y @modelcontextprotocol/server-filesystem .";
      await proxyCommand({ stdio: command });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ stdioCmd: command }),
      );
    });

    it("handles commands with special characters", async () => {
      const command = "python -c \"print('hello')\"";
      await proxyCommand({ stdio: command });

      expect(startSseProxy).toHaveBeenCalledWith(
        expect.objectContaining({ stdioCmd: command }),
      );
    });
  });
});

export {};
