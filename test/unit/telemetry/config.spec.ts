import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock functions must be hoisted for vi.mock factory to access them
const { mockFileExists, mockFileText, mockWrite, mockMkdir } = vi.hoisted(() => ({
  mockFileExists: vi.fn(),
  mockFileText: vi.fn(),
  mockWrite: vi.fn(),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/compat/index.js", () => ({
  file: vi.fn(() => ({
    exists: mockFileExists,
    text: mockFileText,
  })),
  write: mockWrite,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
}));

import { file } from "../../../src/compat/index.js";
import {
  getConfigPath,
  isTelemetryEnabled,
  loadUserConfig,
  saveUserConfig,
  setTelemetryEnabled,
} from "../../../src/telemetry/config.js";

describe("telemetry/config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadUserConfig", () => {
    it("returns empty object when config file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await loadUserConfig();

      expect(result).toEqual({});
      expect(file).toHaveBeenCalled();
      expect(mockFileExists).toHaveBeenCalled();
    });

    it("returns parsed config when file exists", async () => {
      const testConfig = { telemetry: { enabled: true } };
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify(testConfig));

      const result = await loadUserConfig();

      expect(result).toEqual(testConfig);
      expect(mockFileText).toHaveBeenCalled();
    });

    it("returns empty object when JSON parsing fails", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue("invalid json {{{");

      const result = await loadUserConfig();

      expect(result).toEqual({});
    });

    it("returns empty object when file read throws", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockRejectedValue(new Error("Read error"));

      const result = await loadUserConfig();

      expect(result).toEqual({});
    });
  });

  describe("saveUserConfig", () => {
    it("writes config to file with JSON formatting", async () => {
      const testConfig = { telemetry: { enabled: false } };

      await saveUserConfig(testConfig);

      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringContaining("config.json"),
        JSON.stringify(testConfig, null, 2),
      );
    });

    it("creates routermcp directory if not exists", async () => {
      const testConfig = { telemetry: { enabled: true } };

      await saveUserConfig(testConfig);

      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(".config/routermcp"), {
        recursive: true,
      });
    });
  });

  describe("isTelemetryEnabled", () => {
    beforeEach(() => {
      vi.stubEnv("DO_NOT_TRACK", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(["1", "true", "yes"])("returns false when DO_NOT_TRACK=%s", async (value) => {
      vi.stubEnv("DO_NOT_TRACK", value);
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify({ telemetry: { enabled: true } }));

      expect(await isTelemetryEnabled()).toBe(false);
    });

    it.each(["0", "false"])("ignores DO_NOT_TRACK=%s", async (value) => {
      vi.stubEnv("DO_NOT_TRACK", value);
      mockFileExists.mockResolvedValue(false);

      expect(await isTelemetryEnabled()).toBe(true);
    });

    it("returns true when telemetry is enabled", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify({ telemetry: { enabled: true } }));

      const result = await isTelemetryEnabled();

      expect(result).toBe(true);
    });

    it("returns false when telemetry is disabled", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify({ telemetry: { enabled: false } }));

      const result = await isTelemetryEnabled();

      expect(result).toBe(false);
    });

    it("returns true (default) when config file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await isTelemetryEnabled();

      expect(result).toBe(true);
    });

    it("returns true (default) when telemetry key is missing", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify({}));

      const result = await isTelemetryEnabled();

      expect(result).toBe(true);
    });
  });

  describe("setTelemetryEnabled", () => {
    it("enables telemetry and saves config", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify({}));

      await setTelemetryEnabled(true);

      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringContaining("config.json"),
        expect.stringContaining('"enabled": true'),
      );
    });

    it("disables telemetry and saves config", async () => {
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify({}));

      await setTelemetryEnabled(false);

      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringContaining("config.json"),
        expect.stringContaining('"enabled": false'),
      );
    });

    it("preserves existing config when setting telemetry", async () => {
      const existingConfig = { telemetry: { enabled: true }, someOtherKey: "value" };
      mockFileExists.mockResolvedValue(true);
      mockFileText.mockResolvedValue(JSON.stringify(existingConfig));

      await setTelemetryEnabled(false);

      const writeCall = mockWrite.mock.calls[0][1];
      const savedConfig = JSON.parse(writeCall);
      expect(savedConfig.someOtherKey).toBe("value");
      expect(savedConfig.telemetry.enabled).toBe(false);
    });

    it("creates config from scratch when file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      await setTelemetryEnabled(true);

      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringContaining("config.json"),
        expect.stringContaining('"enabled": true'),
      );
    });
  });

  describe("getConfigPath", () => {
    it("returns path to config file in .config/routermcp directory", () => {
      const result = getConfigPath();

      expect(result).toContain(".config/routermcp");
      expect(result).toContain("config.json");
    });

    it("returns absolute path in home directory", () => {
      const result = getConfigPath();

      expect(result).toMatch(/^[/\\]/);
    });
  });
});
