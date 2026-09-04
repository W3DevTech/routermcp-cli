import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { serve, type ServeOptions } from "../../../src/compat/index.js";
import { ConnectionTracker } from "../../../src/daemon/connection-tracker.js";
import { ControlPlane } from "../../../src/control-plane/index.js";
import {
  DAEMON_BRIDGE_LEASES_PATH,
  createHttpServerTransport,
} from "../../../src/transports/http-streamable.js";

describe("createHttpServerTransport bridge lifecycle routes", () => {
  let fetchHandler: (request: Request) => Promise<Response>;
  let serverStop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    serverStop = vi.fn();
    vi.mocked(serve).mockImplementation((options: ServeOptions) => {
      fetchHandler = options.fetch;
      return {
        port: options.port,
        ready: Promise.resolve(options.port),
        stop: serverStop,
      };
    });
  });

  afterEach(() => {
    fetchHandler = undefined as never;
  });

  it("protects lease acquisition and supports heartbeat and release", async () => {
    const tracker = new ConnectionTracker(1000, () => undefined, 10_000);
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      connectionTracker: tracker,
    });
    await handle.start();

    const unauthenticated = await fetchHandler(
      new Request(`http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}`, { method: "POST" }),
    );
    expect(unauthenticated.status).toBe(401);

    const acquired = await fetchHandler(
      new Request(`http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}`, {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(acquired.status).toBe(201);
    const lease = await acquired.json();
    expect(lease).toMatchObject({ leaseId: expect.any(String), leaseTtlMs: 10_000 });

    const heartbeat = await fetchHandler(
      new Request(
        `http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}/${encodeURIComponent(lease.leaseId)}/heartbeat`,
        {
          method: "POST",
          headers: { Authorization: "Bearer secret" },
        },
      ),
    );
    expect(heartbeat.status).toBe(200);
    expect((await heartbeat.json()).leaseId).toBe(lease.leaseId);

    const unauthenticatedMcp = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(unauthenticatedMcp.status).toBe(401);

    const released = await fetchHandler(
      new Request(
        `http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}/${encodeURIComponent(lease.leaseId)}`,
        {
          method: "DELETE",
          headers: { Authorization: "Bearer secret" },
        },
      ),
    );
    expect(released.status).toBe(204);
    expect(tracker.count).toBe(0);

    const missingHeartbeat = await fetchHandler(
      new Request(
        `http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}/${encodeURIComponent(lease.leaseId)}/heartbeat`,
        {
          method: "POST",
          headers: { Authorization: "Bearer secret" },
        },
      ),
    );
    expect(missingHeartbeat.status).toBe(404);

    await handle.stop();
    expect(serverStop).toHaveBeenCalledTimes(1);
    tracker.destroy();
  });

  it("does not expose lease mutations without an explicit auth contract", async () => {
    const tracker = new ConnectionTracker(1000, () => undefined, 10_000);
    const existingLease = tracker.acquire("existing-lease");
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      connectionTracker: tracker,
    });
    await handle.start();

    const unauthenticatedAcquire = await fetchHandler(
      new Request(`http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}`, { method: "POST" }),
    );
    expect(unauthenticatedAcquire.status).toBe(401);

    const unauthenticatedHeartbeat = await fetchHandler(
      new Request(
        `http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}/${encodeURIComponent(existingLease.leaseId)}/heartbeat`,
        { method: "POST" },
      ),
    );
    expect(unauthenticatedHeartbeat.status).toBe(401);

    const unauthenticatedRelease = await fetchHandler(
      new Request(
        `http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}/${encodeURIComponent(existingLease.leaseId)}`,
        { method: "DELETE" },
      ),
    );
    expect(unauthenticatedRelease.status).toBe(401);
    expect(tracker.count).toBe(1);

    // The standalone HTTP MCP surface remains available without a bearer
    // token; only lifecycle state is protected by the explicit contract.
    const mcpDelete = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "standalone-session" },
      }),
    );
    expect(mcpDelete.status).toBe(204);

    await handle.stop();
    tracker.destroy();
  });

  it("supports CORS preflight for the management routes", async () => {
    const tracker = new ConnectionTracker();
    const handle = createHttpServerTransport(7858, "127.0.0.1", { connectionTracker: tracker });
    await handle.start();

    const response = await fetchHandler(
      new Request(`http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}`, { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");

    await handle.stop();
    tracker.destroy();
  });

  it("allows the hosted origin and private-network preflight for token-protected daemons", async () => {
    const tracker = new ConnectionTracker();
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      connectionTracker: tracker,
    });
    await handle.start();

    const preflight = await fetchHandler(
      new Request(`http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://cli.routermcp.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://cli.routermcp.com",
    );
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    expect(preflight.headers.get("Vary")).toContain("Origin");

    const disallowed = await fetchHandler(
      new Request(`http://127.0.0.1${DAEMON_BRIDGE_LEASES_PATH}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    expect(disallowed.status).toBe(204);
    expect(disallowed.headers.get("Access-Control-Allow-Origin")).toBeNull();

    await handle.stop();
    tracker.destroy();
  });

  it("calls the session cleanup callback for DELETE /mcp", async () => {
    const onSessionClose = vi.fn().mockResolvedValue(undefined);
    const handle = createHttpServerTransport(7858, "127.0.0.1", { onSessionClose });
    await handle.start();

    const missingSession = await fetchHandler(
      new Request("http://127.0.0.1/mcp", { method: "DELETE" }),
    );
    expect(missingSession.status).toBe(400);

    const response = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "session-1" },
      }),
    );
    expect(response.status).toBe(204);
    expect(onSessionClose).toHaveBeenCalledWith("session-1");

    await handle.stop();
  });

  it("reports successful MCP initialization with its session and client metadata", async () => {
    const onSessionInitialize = vi.fn();
    const handle = createHttpServerTransport(7858, "127.0.0.1", { onSessionInitialize });
    await handle.start();

    handle.transport.onmessage = (message) => {
      if (!("id" in message) || message.id === undefined) return;
      void handle.transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
    };

    const response = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "2.0.0" },
          },
        }),
      }),
    );

    const sessionId = response.headers.get("Mcp-Session-Id");
    expect(response.status).toBe(200);
    expect(sessionId).toEqual(expect.any(String));
    expect(onSessionInitialize).toHaveBeenCalledWith(sessionId, {
      name: "test-client",
      version: "2.0.0",
    });

    await handle.stop();
  });

  it("keeps duplicate client request IDs isolated across sessions", async () => {
    const handle = createHttpServerTransport(7858, "127.0.0.1");
    await handle.start();

    let dispatchCount = 0;
    handle.transport.onmessage = (message) => {
      if (!("id" in message) || message.id === undefined) return;
      dispatchCount += 1;
      const responseValue = dispatchCount;
      const delay = responseValue === 1 ? 20 : 0;
      setTimeout(() => {
        void handle.transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { responseValue },
        });
      }, delay);
    };

    const first = handle.transport.handleRequestWithSession(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      "session-a",
    );
    const second = handle.transport.handleRequestWithSession(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      "session-b",
    );

    await expect(first).resolves.toMatchObject({ id: 1, result: { responseValue: 1 } });
    await expect(second).resolves.toMatchObject({ id: 1, result: { responseValue: 2 } });

    await handle.stop();
  });
});

describe("createHttpServerTransport control-plane routes", () => {
  let fetchHandler: (request: Request) => Promise<Response>;
  let serverStop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    serverStop = vi.fn();
    vi.mocked(serve).mockImplementation((options: ServeOptions) => {
      fetchHandler = options.fetch;
      return {
        port: options.port,
        ready: Promise.resolve(options.port),
        stop: serverStop,
      };
    });
  });

  afterEach(() => {
    fetchHandler = undefined as never;
  });

  function createControlPlane(
    restart = vi.fn().mockResolvedValue({
      accepted: true,
      message: "restart scheduled",
      state: "stopping" as const,
    }),
    seedMetrics = true,
  ) {
    const controlPlane = new ControlPlane({
      now: () => Date.parse("2026-01-01T00:00:10.000Z"),
      getStatus: () => ({
        state: "ready",
        instanceId: "instance-1",
        pid: 123,
        version: "0.2.1",
        protocolVersion: "1",
        profile: "profile-1",
        configDigest: "digest",
        host: "127.0.0.1",
        port: 7858,
        mcpUrl: "http://127.0.0.1:7858/mcp",
        controlUrl: "http://127.0.0.1:7858",
        startedAt: "2026-01-01T00:00:00.000Z",
        uptimeSeconds: 10,
      }),
      getServers: () => [
        {
          id: "server-1",
          name: "server-1",
          url: "https://user:password@example.com/mcp?token=secret",
          transport: "http-streamable",
          state: "online",
          toolCount: 2,
          lastError: "Bearer super-secret",
        },
      ],
      getSessions: () => [
        {
          id: "session-1",
          kind: "mcp",
          state: "active",
          connectedAt: "2026-01-01T00:00:01.000Z",
          lastSeenAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      getLeases: () => [
        {
          leaseId: "lease-1",
          connectedAt: "2026-01-01T00:00:01.000Z",
          lastSeenAt: "2026-01-01T00:00:02.000Z",
          leaseExpiresAt: "2026-01-01T00:01:00.000Z",
          leaseTtlMs: 30_000,
        },
      ],
      restart,
    });
    if (seedMetrics) {
      controlPlane.recordRequest({ durationMs: 10, method: "tools/call" });
      controlPlane.recordRequest({ durationMs: 30, method: "ping", error: true });
    }
    controlPlane.recordEvent({
      level: "error",
      type: "test.event",
      message: "Bearer super-secret https://user:password@example.com/?token=secret",
    });
    return { controlPlane, restart };
  }

  it("serves authenticated status, snapshots, metrics, events, and restart", async () => {
    const { controlPlane, restart } = createControlPlane();
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
    });
    await handle.start();

    const unauthorized = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status", { method: "GET" }),
    );
    expect(unauthorized.status).toBe(401);

    const headers = {
      Authorization: "Bearer secret",
      Origin: "https://cli.routermcp.com",
    };
    const status = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status", { headers }),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      status: expect.objectContaining({ instanceId: "instance-1", port: 7858 }),
    });
    expect(status.headers.get("Access-Control-Allow-Origin")).toBe("https://cli.routermcp.com");

    const servers = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/servers", { headers }),
    );
    expect((await servers.json()).servers[0]).toMatchObject({
      url: "https://example.com/mcp",
      lastError: "Bearer [redacted]",
    });

    const sessions = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/sessions", { headers }),
    );
    expect((await sessions.json()).sessions).toHaveLength(1);

    const metrics = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/metrics", { headers }),
    );
    expect(await metrics.json()).toMatchObject({
      metrics: {
        requestsTotal: 2,
        errorsTotal: 1,
        toolCallsTotal: 1,
        activeSessions: 1,
        activeLeases: 1,
        latencyMs: { p50: 10, p95: 30, p99: 30 },
      },
    });

    const events = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/events?limit=1", { headers }),
    );
    const eventPayload = await events.json();
    expect(eventPayload.events).toHaveLength(1);
    expect(eventPayload.events[0].message).not.toContain("super-secret");
    expect(eventPayload.events[0].message).not.toContain("password");

    const restartResponse = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/restart", { method: "POST", headers }),
    );
    expect(restartResponse.status).toBe(202);
    expect(restart).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("returns a stable response for concurrent restart requests", async () => {
    let resolveRestart: ((value: { accepted: true; message: string }) => void) | undefined;
    const restart = vi.fn(
      () =>
        new Promise<{ accepted: true; message: string }>((resolve) => {
          resolveRestart = resolve;
        }),
    );
    const { controlPlane } = createControlPlane(restart);
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
    });
    await handle.start();

    const request = () =>
      fetchHandler(
        new Request("http://127.0.0.1/api/v1/restart", {
          method: "POST",
          headers: { Authorization: "Bearer secret" },
        }),
      );
    const first = request();
    const second = request();
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    resolveRestart?.({ accepted: true, message: "restart scheduled" });
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);

    await handle.stop();
  });

  it("handles exact-origin private-network preflight and rejects wrong query shapes", async () => {
    const { controlPlane } = createControlPlane();
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
    });
    await handle.start();

    const preflight = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status", {
        method: "OPTIONS",
        headers: {
          Origin: "https://cli.routermcp.com",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true");

    const wrongOrigin = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status", {
        headers: { Authorization: "Bearer secret", Origin: "https://evil.example" },
      }),
    );
    expect(wrongOrigin.status).toBe(200);
    expect(wrongOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const invalidQuery = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status?token=secret", {
        headers: {
          Authorization: "Bearer secret",
          Origin: "https://cli.routermcp.com",
        },
      }),
    );
    expect(invalidQuery.status).toBe(400);
    expect(invalidQuery.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://cli.routermcp.com",
    );
    expect(await invalidQuery.json()).toEqual({
      error: "Invalid request",
      message: "The status endpoint does not accept query parameters",
    });

    await handle.stop();
  });

  it("counts application-level MCP tool errors in management metrics", async () => {
    const { controlPlane } = createControlPlane(undefined, false);
    const handle = createHttpServerTransport(7858, "127.0.0.1", { controlPlane });
    await handle.start();

    handle.transport.onmessage = (message) => {
      if (!("id" in message) || message.id === undefined) return;
      void handle.transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "upstream failed" }],
          isError: true,
        },
      });
    };

    const response = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "test", arguments: {} },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).toBe(true);
    expect(controlPlane.getMetrics()).toMatchObject({
      requestsTotal: 1,
      errorsTotal: 1,
      errorRate: 100,
      toolCallsTotal: 1,
    });

    await handle.stop();
  });
});
