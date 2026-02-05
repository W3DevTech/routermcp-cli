import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("../../../src/config/loader.js", () => ({
  resolveConfigFromPath: vi.fn(),
  getScopeLabel: vi.fn(() => "Project-local"),
}));

vi.mock("../../../src/core/gateway.js", () => ({
  createGateway: vi.fn(),
}));

vi.mock("../../../src/daemon/index.js", () => ({
  getProjectId: vi.fn(() => "test-project-id"),
  getDaemonPaths: vi.fn(() => ({
    dir: "/tmp/daemon",
    pid: "/tmp/daemon/daemon.pid",
    port: "/tmp/daemon/daemon.port",
    socket: "/tmp/daemon/daemon.sock",
  })),
}));

vi.mock("../../../src/cli/config.js", () => ({
  configCommand: vi.fn(),
}));

import { mkdirSync, writeFileSync } from "node:fs";
import { serveCommand } from "../../../src/cli/serve.js";
import { resolveConfigFromPath } from "../../../src/config/loader.js";
import { createGateway } from "../../../src/core/gateway.js";
import { ConfigError, RouterMcpError } from "../../../src/utils/errors.js";

describe("serveCommand", () => {
  let mockGateway: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    getSessionStats: ReturnType<typeof vi.fn>;
  };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGateway = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getSessionStats: vi.fn(() => ({ activeSessions: 1, maxSessions: 25 })),
    };

    vi.mocked(createGateway).mockReturnValue(mockGateway as never);
    vi.mocked(resolveConfigFromPath).mockResolvedValue({
      config: {
        mcpServers: {
          test: { transport: "stdio", command: "echo", args: ["test"] },
        },
      },
      path: "/path/to/routermcp.jsonc",
      scope: "project-local",
    });

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("mode selection", () => {
    it("uses stdio mode by default", async () => {
      const startPromise = serveCommand({});

      await vi.waitFor(() => {
        expect(createGateway).toHaveBeenCalled();
      });

      expect(createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "stdio",
        }),
      );

      mockGateway.stop();
    });

    it("uses http-streamable mode when --http is specified", async () => {
      const startPromise = serveCommand({ http: 3000 });

      await vi.waitFor(() => {
        expect(createGateway).toHaveBeenCalled();
      });

      expect(createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "http-streamable",
          httpPort: 3000,
        }),
      );

      mockGateway.stop();
    });

    it("uses http-streamable mode with default port in daemon mode", async () => {
      const startPromise = serveCommand({ daemonMode: true });

      await vi.waitFor(() => {
        expect(createGateway).toHaveBeenCalled();
      });

      expect(createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "http-streamable",
          httpPort: 7858,
        }),
      );

      mockGateway.stop();
    });
  });

  describe("config loading", () => {
    it("loads config from default path when no config specified", async () => {
      const startPromise = serveCommand({});

      await vi.waitFor(() => {
        expect(resolveConfigFromPath).toHaveBeenCalled();
      });

      expect(resolveConfigFromPath).toHaveBeenCalledWith(undefined);

      mockGateway.stop();
    });

    it("loads config from specified path", async () => {
      const startPromise = serveCommand({ config: "/custom/config.jsonc" });

      await vi.waitFor(() => {
        expect(resolveConfigFromPath).toHaveBeenCalled();
      });

      expect(resolveConfigFromPath).toHaveBeenCalledWith("/custom/config.jsonc");

      mockGateway.stop();
    });

    it("logs config info in verbose mode", async () => {
      const startPromise = serveCommand({ verbose: true });

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Loaded config from:"),
        );
      });

      mockGateway.stop();
    });
  });

  describe("daemon mode", () => {
    it("creates daemon directory and PID file", async () => {
      const startPromise = serveCommand({ daemonMode: true });

      await vi.waitFor(() => {
        expect(mkdirSync).toHaveBeenCalled();
      });

      expect(mkdirSync).toHaveBeenCalledWith("/tmp/daemon", { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith("/tmp/daemon/daemon.pid", expect.any(String));

      mockGateway.stop();
    });

    it("writes port file after gateway starts", async () => {
      const startPromise = serveCommand({ daemonMode: true });

      await vi.waitFor(() => {
        expect(writeFileSync).toHaveBeenCalledWith("/tmp/daemon/daemon.port", "7858");
      });

      mockGateway.stop();
    });
  });

  describe("gateway lifecycle", () => {
    it("creates and starts gateway", async () => {
      const startPromise = serveCommand({});

      await vi.waitFor(() => {
        expect(mockGateway.start).toHaveBeenCalled();
      });

      expect(createGateway).toHaveBeenCalled();
      expect(mockGateway.start).toHaveBeenCalled();

      mockGateway.stop();
    });

    it("passes clearCache option to gateway", async () => {
      const startPromise = serveCommand({ clearCache: true });

      await vi.waitFor(() => {
        expect(createGateway).toHaveBeenCalled();
      });

      expect(createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          clearOpenApiCache: true,
        }),
      );

      mockGateway.stop();
    });
  });

  describe("error handling", () => {
    it("handles ConfigError with no config file", async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });

      vi.mocked(resolveConfigFromPath).mockRejectedValue(
        new ConfigError("No config file found in current directory"),
      );

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      await expect(serveCommand({})).rejects.toThrow("process.exit called");

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("No config file found"));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, writable: true });
    });

    it("handles RouterMcpError", async () => {
      vi.mocked(resolveConfigFromPath).mockRejectedValue(
        new RouterMcpError("Some MCP error", "TEST_ERROR"),
      );

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      await expect(serveCommand({})).rejects.toThrow("process.exit called");

      expect(consoleErrorSpy).toHaveBeenCalledWith("Error: Some MCP error");
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it("rethrows unknown errors", async () => {
      const unknownError = new Error("Unknown error");
      vi.mocked(resolveConfigFromPath).mockRejectedValue(unknownError);

      await expect(serveCommand({})).rejects.toThrow("Unknown error");
    });
  });
});
