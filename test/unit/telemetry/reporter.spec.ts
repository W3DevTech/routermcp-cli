import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterMcpError } from "../../../src/utils/errors.js";

const mockIsTelemetryEnabled = vi.fn();

vi.mock("../../../src/telemetry/config.js", () => ({
  isTelemetryEnabled: () => mockIsTelemetryEnabled(),
}));

import {
  buildTelemetryEvent,
  reportError,
  sendTelemetryEvent,
} from "../../../src/telemetry/reporter.js";

describe("telemetry/reporter", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalBun: unknown;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn().mockResolvedValue(new Response());
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    originalBun = (globalThis as any).Bun;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalBun !== undefined) {
      (globalThis as any).Bun = originalBun;
    } else {
      (globalThis as any).Bun = undefined;
    }
  });

  describe("buildTelemetryEvent", () => {
    it("creates event with error details", () => {
      const error = new Error("Test error message");
      error.stack = "Error: Test error message\n    at test.ts:1:1";
      const context = { command: "serve", args: ["--http", "3000"] };

      const event = buildTelemetryEvent(error, context);

      expect(event.error.message).toBe("Test error message");
      expect(event.error.name).toBe("Error");
      expect(event.error.stack).toBe("Error: Test error message\n    at test.ts:1:1");
      expect(event.error.code).toBe("UNKNOWN");
    });

    it("extracts error code from RouterMcpError", () => {
      const error = new RouterMcpError("Config error", "CONFIG_ERROR");
      const context = { command: "config", args: [] };

      const event = buildTelemetryEvent(error, context);

      expect(event.error.code).toBe("CONFIG_ERROR");
      expect(event.error.name).toBe("RouterMcpError");
    });

    it("includes CLI context", () => {
      const error = new Error("Test");
      const context = { command: "tunnel", args: ["--tunnel=cloudflare", "-v"] };

      const event = buildTelemetryEvent(error, context);

      expect(event.cli.command).toBe("tunnel");
      expect(event.cli.args).toEqual(["--tunnel=cloudflare", "-v"]);
      expect(event.cli.version).toBeDefined();
    });

    it("includes environment info", () => {
      const error = new Error("Test");
      const context = { command: "serve", args: [] };

      const event = buildTelemetryEvent(error, context);

      expect(event.environment.platform).toBe(process.platform);
      expect(event.environment.arch).toBe(process.arch);
      expect(["bun", "node"]).toContain(event.environment.runtime);
      expect(event.environment.runtime_version).toBeDefined();
    });

    it("includes timestamp and metadata", () => {
      const error = new Error("Test");
      const context = { command: "serve", args: [] };

      const event = buildTelemetryEvent(error, context);

      expect(event._time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.level).toBe("error");
      expect(event.event_type).toBe("cli_error");
      expect(event.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("handles errors without stack trace", () => {
      const error = new Error("No stack");
      error.stack = undefined;
      const context = { command: "serve", args: [] };

      const event = buildTelemetryEvent(error, context);

      expect(event.error.stack).toBe("");
    });

    it("detects Bun runtime when available", () => {
      (globalThis as any).Bun = { version: "1.0.0" };

      const error = new Error("Test");
      const context = { command: "serve", args: [] };
      const event = buildTelemetryEvent(error, context);

      expect(event.environment.runtime).toBe("bun");
      expect(event.environment.runtime_version).toBe("1.0.0");
    });

    it("detects Node runtime when Bun is not available", () => {
      (globalThis as any).Bun = undefined;

      const error = new Error("Test");
      const context = { command: "serve", args: [] };
      const event = buildTelemetryEvent(error, context);

      expect(event.environment.runtime).toBe("node");
      expect(event.environment.runtime_version).toBe(process.version);
    });
  });

  describe("sendTelemetryEvent", () => {
    it("sends event to telemetry endpoint", async () => {
      const event = buildTelemetryEvent(new Error("Test"), { command: "serve", args: [] });

      await sendTelemetryEvent(event);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://telemetry.routermcp.com/v1/ingest",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([event]),
        }),
      );
    });

    it("uses abort signal for timeout", async () => {
      const event = buildTelemetryEvent(new Error("Test"), { command: "serve", args: [] });

      await sendTelemetryEvent(event);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("silently handles fetch errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      const event = buildTelemetryEvent(new Error("Test"), { command: "serve", args: [] });

      await expect(sendTelemetryEvent(event)).resolves.toBeUndefined();
    });

    it("silently handles abort errors", async () => {
      mockFetch.mockImplementation(() => {
        throw new DOMException("Aborted", "AbortError");
      });
      const event = buildTelemetryEvent(new Error("Test"), { command: "serve", args: [] });

      await expect(sendTelemetryEvent(event)).resolves.toBeUndefined();
    });
  });

  describe("reportError", () => {
    it("sends error when telemetry is enabled", async () => {
      mockIsTelemetryEnabled.mockResolvedValue(true);
      const error = new Error("Test error");
      const context = { command: "serve", args: [] };

      await reportError(error, context);

      expect(mockIsTelemetryEnabled).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalled();
    });

    it("does not send error when telemetry is disabled", async () => {
      mockIsTelemetryEnabled.mockResolvedValue(false);
      const error = new Error("Test error");
      const context = { command: "serve", args: [] };

      await reportError(error, context);

      expect(mockIsTelemetryEnabled).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("silently catches any errors during reporting", async () => {
      mockIsTelemetryEnabled.mockRejectedValue(new Error("Config error"));
      const error = new Error("Test error");
      const context = { command: "serve", args: [] };

      await expect(reportError(error, context)).resolves.toBeUndefined();
    });

    it("silently handles errors during event building", async () => {
      mockIsTelemetryEnabled.mockResolvedValue(true);
      mockFetch.mockRejectedValue(new Error("Send failed"));

      const error = new Error("Test error");
      const context = { command: "serve", args: [] };

      await expect(reportError(error, context)).resolves.toBeUndefined();
    });
  });
});
