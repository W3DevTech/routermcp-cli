import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryCommand } from "../../../src/cli/telemetry.js";

vi.mock("@clack/prompts", () => ({
  log: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../../../src/telemetry/index.js", () => ({
  isTelemetryEnabled: vi.fn(),
  setTelemetryEnabled: vi.fn(),
  getConfigPath: vi.fn(() => "/home/user/.routermcp/config.json"),
}));

import * as p from "@clack/prompts";
import {
  getConfigPath,
  isTelemetryEnabled,
  setTelemetryEnabled,
} from "../../../src/telemetry/index.js";

describe("telemetryCommand", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("enable action", () => {
    it("calls setTelemetryEnabled with true", async () => {
      await telemetryCommand("enable");

      expect(setTelemetryEnabled).toHaveBeenCalledWith(true);
      expect(p.log.success).toHaveBeenCalledWith("Telemetry enabled");
    });

    it("logs config path to stderr", async () => {
      await telemetryCommand("enable");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Configuration saved to:"),
      );
    });
  });

  describe("disable action", () => {
    it("calls setTelemetryEnabled with false", async () => {
      await telemetryCommand("disable");

      expect(setTelemetryEnabled).toHaveBeenCalledWith(false);
      expect(p.log.success).toHaveBeenCalledWith("Telemetry disabled");
    });

    it("logs config path to stderr", async () => {
      await telemetryCommand("disable");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Configuration saved to:"),
      );
    });
  });

  describe("status action", () => {
    it("displays enabled status when telemetry is on", async () => {
      vi.mocked(isTelemetryEnabled).mockResolvedValue(true);

      await telemetryCommand("status");

      expect(isTelemetryEnabled).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Enabled: Yes"));
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("To disable: routermcp telemetry disable"),
      );
    });

    it("displays disabled status when telemetry is off", async () => {
      vi.mocked(isTelemetryEnabled).mockResolvedValue(false);

      await telemetryCommand("status");

      expect(isTelemetryEnabled).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Enabled: No"));
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("To enable: routermcp telemetry enable"),
      );
    });

    it("displays config path", async () => {
      vi.mocked(isTelemetryEnabled).mockResolvedValue(true);

      await telemetryCommand("status");

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("/home/user/.routermcp/config.json"),
      );
    });
  });

  describe("no action (default to status)", () => {
    it("shows status when no action provided", async () => {
      vi.mocked(isTelemetryEnabled).mockResolvedValue(true);

      await telemetryCommand(undefined);

      expect(isTelemetryEnabled).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Telemetry Status"));
    });
  });
});
