import { describe, expect, it, vi } from "vitest";
import {
  boundEventLimit,
  ControlPlane,
  sanitizeText,
  sanitizeUrl,
  type ControlPlaneServer,
  type ControlPlaneStatus,
} from "../../src/control-plane/index.js";

describe("ControlPlane", () => {
  it("tracks request metrics and keeps newest events within the bounded feed", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const controlPlane = new ControlPlane({
      now: () => now,
      getStatus: () => ({
        state: "ready",
        instanceId: "instance",
        version: "0.2.1",
        protocolVersion: "1",
        profile: "profile",
        configDigest: "digest",
        host: "127.0.0.1",
        port: 7858,
        mcpUrl: "http://127.0.0.1:7858/mcp",
        controlUrl: "http://127.0.0.1:7858",
        startedAt: new Date(now).toISOString(),
        uptimeSeconds: 0,
      }),
      getServers: () => [],
      getSessions: () => [{
        id: "session",
        kind: "mcp",
        state: "active",
        connectedAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
      }],
      getLeases: () => [],
    });

    controlPlane.recordRequest({ durationMs: 10, method: "tools/call" });
    controlPlane.recordRequest({ durationMs: 50, method: "ping", resultError: true });
    now += 10_000;

    expect(controlPlane.getMetrics()).toMatchObject({
      requestsTotal: 2,
      requestsPerSecond: 0.2,
      errorsTotal: 1,
      errorRate: 50,
      toolCallsTotal: 1,
      activeSessions: 1,
      latencyMs: { p50: 10, p95: 50, p99: 50 },
    });

    controlPlane.recordEvent({ level: "info", type: "older", message: "older" });
    controlPlane.recordEvent({ level: "info", type: "newer", message: "newer" });
    expect(controlPlane.getEvents(1)).toEqual([
      expect.objectContaining({ type: "newer", message: "newer" }),
    ]);
  });

  it("deduplicates concurrent restarts", async () => {
    let resolveRestart: ((value: { accepted: true; message: string }) => void) | undefined;
    const restart = vi.fn(
      () =>
        new Promise<{ accepted: true; message: string }>((resolve) => {
          resolveRestart = resolve;
        }),
    );
    const controlPlane = new ControlPlane({
      getStatus: () => ({
        state: "ready",
        instanceId: "instance",
        version: "0.2.1",
        protocolVersion: "1",
        profile: "profile",
        configDigest: "digest",
        host: "127.0.0.1",
        port: 7858,
        mcpUrl: "http://127.0.0.1:7858/mcp",
        controlUrl: "http://127.0.0.1:7858",
        startedAt: "2026-01-01T00:00:00.000Z",
        uptimeSeconds: 0,
      }),
      getServers: () => [],
      getSessions: () => [],
      restart,
    });

    const first = controlPlane.restart();
    const second = controlPlane.restart();
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    resolveRestart?.({ accepted: true, message: "scheduled" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { accepted: true, message: "scheduled" },
      { accepted: true, message: "scheduled" },
    ]);
  });

  it("allowlists browser-visible snapshots instead of forwarding provider fields", () => {
    const controlPlane = new ControlPlane({
      getStatus: () =>
        ({
          state: "ready",
          instanceId: "instance",
          pid: 123,
          version: "0.2.1",
          protocolVersion: "1",
          profile: "profile",
          configDigest: "digest",
          host: "127.0.0.1",
          port: 7858,
          mcpUrl: "http://127.0.0.1:7858/mcp",
          controlUrl: "http://127.0.0.1:7858",
          startedAt: "2026-01-01T00:00:00.000Z",
          uptimeSeconds: 1,
          localAuthToken: "secret-token",
        }) as ControlPlaneStatus & { localAuthToken: string },
      getServers: () => [
        {
          id: "server",
          name: "server",
          state: "online",
          toolCount: 1,
          localAuthToken: "secret-token",
          headers: { Authorization: "Bearer secret-token" },
        } as ControlPlaneServer & {
          localAuthToken: string;
          headers: Record<string, string>;
        },
      ],
      getSessions: () => [],
    });

    expect(controlPlane.getStatus()).not.toHaveProperty("localAuthToken");
    expect(controlPlane.getServers()[0]).not.toHaveProperty("localAuthToken");
    expect(controlPlane.getServers()[0]).not.toHaveProperty("headers");
  });
});

describe("control-plane redaction helpers", () => {
  it("removes bearer, URL credential, and query secret material", () => {
    const value = sanitizeText(
      "Bearer token https://user:password@example.com/mcp?api_key=secret&x=1",
    );
    expect(value).toBe("Bearer [redacted] https://[redacted]@example.com/mcp?api_key=[redacted]&x=1");
    expect(sanitizeUrl("https://user:password@example.com/mcp?token=secret")).toBe(
      "https://example.com/mcp",
    );
  });

  it("bounds event limits to a safe range", () => {
    expect(boundEventLimit(Number.NaN)).toBe(40);
    expect(boundEventLimit(0)).toBe(1);
    expect(boundEventLimit(9.8)).toBe(9);
    expect(boundEventLimit(999)).toBe(200);
  });
});
