import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../../../src/config/loader.js", () => ({
  resolveConfig: vi.fn(),
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
  ensureRunning: vi.fn(),
  startDaemon: vi.fn(),
  isWindows: vi.fn(() => false),
}));

import { createInterface } from "node:readline";
import { type ConnectCommandOptions, connectCommand } from "../../../src/cli/connect.js";
import { resolveConfig } from "../../../src/config/loader.js";
import {
  getDaemonPaths,
  getDaemonStatus,
  getProjectId,
  ensureRunning,
} from "../../../src/daemon/index.js";

describe("connectCommand", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let mockRl: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockRl = {
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValue(mockRl as never);

    vi.mocked(resolveConfig).mockResolvedValue({
      config: { mcpServers: {} },
      path: "/path/to/routermcp.jsonc",
      scope: "project-local",
    });
    vi.mocked(ensureRunning).mockResolvedValue({
      running: true,
      pid: 12345,
      port: 5151,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("config file handling", () => {
    it("fails when no config file found", async () => {
      vi.mocked(resolveConfig).mockResolvedValue(null);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(connectCommand({})).rejects.toThrow("process.exit called");

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("No config file found"));
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
        expect(resolveConfig).toHaveBeenCalledWith("/custom/project");
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

      expect(ensureRunning).toHaveBeenCalled();
    });

    it("starts daemon when not running", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ running: false });
      vi.mocked(ensureRunning).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(ensureRunning).toHaveBeenCalled();
      });
    });

    it("passes verbose flag to startDaemon", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ running: false });
      vi.mocked(ensureRunning).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({ verbose: true });

      await vi.waitFor(() => {
        expect(ensureRunning).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ verbose: true }),
        );
      });
    });
  });

  describe("legacy socket manifests", () => {
    it("uses HTTP when a legacy socket and port are both present", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
        socket: "/tmp/daemon/daemon.sock",
      });
      vi.mocked(ensureRunning).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
        socket: "/tmp/daemon/daemon.sock",
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(createInterface).toHaveBeenCalled();
      });
    });

    it("does not use a legacy socket when no port is available", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        socket: "/tmp/daemon/daemon.sock",
      });
      vi.mocked(ensureRunning).mockResolvedValue({
        running: true,
        pid: 12345,
        socket: "/tmp/daemon/daemon.sock",
      });

      await expect(connectCommand({})).rejects.toThrow("Daemon did not report socket or HTTP port");
    });
  });

  describe("HTTP proxy mode", () => {
    it("uses HTTP proxy when only port is available", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });
      vi.mocked(ensureRunning).mockResolvedValue({
        running: true,
        pid: 12345,
        port: 5151,
      });

      connectCommand({});

      await vi.waitFor(() => {
        expect(createInterface).toHaveBeenCalled();
      });

    });

    it("throws error when daemon has no socket or port", async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ running: false });
      vi.mocked(ensureRunning).mockResolvedValue({
        running: true,
        pid: 12345,
      });

      await expect(connectCommand({})).rejects.toThrow("Daemon did not report socket or HTTP port");
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
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("[connect]"));
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
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Project ID"));
      });
    });
  });
});
