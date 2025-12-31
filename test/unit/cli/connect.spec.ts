import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("node:net", () => ({
  createConnection: vi.fn(() => ({
    on: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock("../../../src/config/loader.js", () => ({
  loadConfigFromPath: vi.fn(),
  findConfigFile: vi.fn(),
}));

vi.mock("../../../src/daemon/index.js", () => ({
  getProjectId: vi.fn(() => "test-project-id"),
  getDaemonPaths: vi.fn(() => ({
    dir: "/tmp/daemon",
    pid: "/tmp/daemon/daemon.pid",
    port: "/tmp/daemon/daemon.port",
    socket: "/tmp/daemon/daemon.sock",
    configPath: "/path/to/config.jsonc",
  })),
  getDaemonStatus: vi.fn(),
  startDaemon: vi.fn(),
  isWindows: vi.fn(() => false),
}));

import { connectCommand, type ConnectCommandOptions } from "../../../src/cli/connect.js";
import { findConfigFile } from "../../../src/config/loader.js";
import {
  getProjectId,
  getDaemonPaths,
  getDaemonStatus,
  startDaemon,
  isWindows,
} from "../../../src/daemon/index.js";
import { createInterface } from "node:readline";
import { createConnection } from "node:net";

describe("connectCommand", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let mockRl: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let mockSocket: {
    on: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockRl = {
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValue(mockRl as never);

    mockSocket = {
      on: vi.fn().mockReturnThis(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    vi.mocked(createConnection).mockReturnValue(mockSocket as never);

    vi.mocked(findConfigFile).mockResolvedValue("/path/to/routermcp.jsonc");
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("config file handling", () => {
    it("fails when no config file found", async () => {
      vi.mocked(findConfigFile).mockResolvedValue(null);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(connectCommand({})).rejects.toThrow("process.exit called");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("No config file found"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it("uses custom config path when provided", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        port: 5151,
      });

      connectCommand({ config: "/custom/config.jsonc" });

      await vi.waitFor(() => {
        expect(getDaemonPaths).toHaveBeenCalled();
      });

      expect(getProjectId).toHaveBeenCalled();
    });

    it("uses project path for finding config", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        port: 5151,
      });

      connectCommand({ project: "/custom/project" });

      await vi.waitFor(() => {
        expect(findConfigFile).toHaveBeenCalledWith("/custom/project");
      });

      expect(getProjectId).toHaveBeenCalledWith("/custom/project");
    });
  });

  describe("daemon lifecycle", () => {
    it("connects to existing running daemon", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(getDaemonStatus).toHaveBeenCalled();
      });

      expect(startDaemon).not.toHaveBeenCalled();
    });

    it("starts daemon when not running", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ running: false });
      vi.mocked(startDaemon).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(startDaemon).toHaveBeenCalled();
      });
    });

    it("passes verbose flag to startDaemon", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ running: false });
      vi.mocked(startDaemon).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({ verbose: true });

      await vi.waitFor(() => {
        expect(startDaemon).toHaveBeenCalledWith(expect.any(Object), true);
      });
    });
  });

  describe("socket proxy mode", () => {
    it("uses socket proxy when socket is available and not Windows", async () => {
      vi.mocked(isWindows).mockReturnValue(false);
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
        socket: "/tmp/daemon/daemon.sock",
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(createConnection).toHaveBeenCalledWith("/tmp/daemon/daemon.sock");
      });
    });

    it("falls back to HTTP proxy on Windows even if socket exists", async () => {
      vi.mocked(isWindows).mockReturnValue(true);
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
        socket: "/tmp/daemon/daemon.sock",
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(createInterface).toHaveBeenCalled();
      });

      expect(createConnection).not.toHaveBeenCalled();
    });
  });

  describe("HTTP proxy mode", () => {
    it("uses HTTP proxy when only port is available", async () => {
      vi.mocked(isWindows).mockReturnValue(false);
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(createInterface).toHaveBeenCalled();
      });

      expect(createConnection).not.toHaveBeenCalled();
    });

    it("throws error when daemon has no socket or port", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ running: false });
      vi.mocked(startDaemon).mockResolvedValue({
        running: true,
        pid: 12345,
      });

      await expect(connectCommand({})).rejects.toThrow(
        "Daemon did not report socket or HTTP port",
      );
    });
  });

  describe("verbose logging", () => {
    it("logs daemon status in verbose mode", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({ verbose: true });

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining("[connect]"),
        );
      });
    });

    it("logs project ID in verbose mode", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({ verbose: true });

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Project ID"),
        );
      });
    });
  });
});

export {};
