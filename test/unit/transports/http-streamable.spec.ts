import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { serve, type ServeOptions } from "../../../src/compat/index.js";
import { ConnectionTracker } from "../../../src/daemon/connection-tracker.js";
import {
  ControlPlane,
  MANAGEMENT_BODY_LIMIT_BYTES,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
  ManagementCredentialStore,
} from "../../../src/control-plane/index.js";
import type {
  ControlPlaneMetrics,
  ControlPlaneStatus,
  ControlPlaneWorkspace,
} from "../../../src/control-plane/index.js";
import {
  DAEMON_BRIDGE_LEASES_PATH,
  DAEMON_BRIDGE_LEASE_HEADER,
  DAEMON_WORKSPACE_HEADER,
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

  it.each(["http://localhost:7953", "http://127.0.0.1:7953"])(
    "allows the documented local Next.js origin (%s) without enabling wildcard CORS",
    async (origin) => {
      const handle = createHttpServerTransport(7858, "127.0.0.1", { authToken: "secret" });
      await handle.start();

      const response = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/status", {
          headers: {
            Authorization: "Bearer secret",
            Origin: origin,
          },
        }),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(response.headers.get("Access-Control-Allow-Origin")).not.toBe("*");

      await handle.stop();
    },
  );

  it("does not broaden the authenticated CORS policy to nearby or arbitrary origins", async () => {
    const handle = createHttpServerTransport(7858, "127.0.0.1", { authToken: "secret" });
    await handle.start();

    for (const origin of [
      "http://localhost:7954",
      "http://127.0.0.1:3000",
      "https://localhost:7953",
      "https://evil.example",
    ]) {
      const response = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/status", {
          headers: {
            Authorization: "Bearer secret",
            Origin: origin,
          },
        }),
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }

    await handle.stop();
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
    expect(onSessionClose).toHaveBeenCalledWith("session-1", undefined);

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
    expect(onSessionInitialize).toHaveBeenCalledWith(
      sessionId,
      {
        name: "test-client",
        version: "2.0.0",
      },
      undefined,
    );

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

  it("dispatches MCP requests through a host-provided workspace handler", async () => {
    const dispatchMcp = vi.fn(async (message, sessionId, context) => ({
      jsonrpc: "2.0" as const,
      id: "id" in message ? message.id : null,
      result: {
        sessionId,
        workspaceId: context?.workspaceId ?? null,
      },
    }));
    const handle = createHttpServerTransport(7858, "127.0.0.1", { dispatchMcp });
    await handle.start();

    const response = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "session-a" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { sessionId: "session-a", workspaceId: null },
    });
    expect(dispatchMcp).toHaveBeenCalledWith(
      expect.objectContaining({ method: "tools/list" }),
      "session-a",
      undefined,
    );

    await handle.stop();
  });

  it("rejects a session when a later lease claims another workspace", async () => {
    const tracker = new ConnectionTracker();
    const firstLease = tracker.acquire("lease-a", { workspaceId: "workspace-a" });
    const secondLease = tracker.acquire("lease-b", { workspaceId: "workspace-b" });
    const dispatchMcp = vi.fn(async (message) => ({
      jsonrpc: "2.0" as const,
      id: "id" in message ? message.id : null,
      result: {},
    }));
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      connectionTracker: tracker,
      dispatchMcp,
    });
    await handle.start();

    const first = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "session-a",
          [DAEMON_BRIDGE_LEASE_HEADER]: firstLease.leaseId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(first.status).toBe(200);

    const conflicting = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "session-a",
          [DAEMON_BRIDGE_LEASE_HEADER]: secondLease.leaseId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );
    expect(conflicting.status).toBe(500);
    expect((await conflicting.json()).error.message).toContain("already bound");
    expect(dispatchMcp).toHaveBeenCalledTimes(1);

    await handle.stop();
    tracker.destroy();
  });

  it("fails closed when a request carries an unknown bridge lease", async () => {
    const tracker = new ConnectionTracker();
    const lease = tracker.acquire("stale-lease", { workspaceId: "workspace-a" });
    tracker.remove(lease.leaseId);
    const dispatchMcp = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {},
    }));
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      connectionTracker: tracker,
      dispatchMcp,
    });
    await handle.start();

    const response = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          [DAEMON_BRIDGE_LEASE_HEADER]: lease.leaseId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe(
      "MCP bridge authorization is invalid or expired",
    );
    expect(dispatchMcp).not.toHaveBeenCalled();

    await handle.stop();
    tracker.destroy();
  });

  it("does not route a workspace header without a lease to the current workspace", async () => {
    const tracker = new ConnectionTracker();
    const dispatchMcp = vi.fn(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {},
    }));
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      connectionTracker: tracker,
      dispatchMcp,
    });
    await handle.start();

    const response = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          [DAEMON_WORKSPACE_HEADER]: "workspace-b",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("requires a bridge lease");
    expect(dispatchMcp).not.toHaveBeenCalled();

    await handle.stop();
    tracker.destroy();
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

  it("serves authenticated workspace inventory and context status", async () => {
    const workspace: ControlPlaneWorkspace = {
      id: "workspace-1",
      directory: "/tmp/project-a",
      configPath: "/tmp/project-a/routermcp.jsonc",
      configScope: "project-local",
      profileId: "profile-1",
      configDigest: "a".repeat(64),
      state: "known",
      activeConnections: 0,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const controlPlane = new ControlPlane({
      getStatus: () => ({
        state: "ready",
        instanceId: "instance-1",
        version: "0.2.1",
        protocolVersion: "1",
        profile: "profile-1",
        configDigest: workspace.configDigest,
        host: "127.0.0.1",
        port: 7858,
        mcpUrl: "http://127.0.0.1:7858/mcp",
        controlUrl: "http://127.0.0.1:7858",
        startedAt: "2026-01-01T00:00:00.000Z",
        uptimeSeconds: 1,
      }),
      getServers: () => [],
      getSessions: () => [],
      getCurrentWorkspaceId: () => workspace.id,
      getWorkspaces: () => [workspace],
    });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
    });
    await handle.start();

    const headers = { Authorization: "Bearer secret" };
    const inventory = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/workspaces", { headers }),
    );
    expect(inventory.status).toBe(200);
    expect((await inventory.json()).workspaces).toEqual([
      expect.objectContaining({ id: workspace.id, state: "current", directory: workspace.directory }),
    ]);

    const status = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/status`, { headers }),
    );
    expect(status.status).toBe(200);
    const statusPayload = await status.json();
    expect(statusPayload).toEqual(
      expect.objectContaining({
        workspace: expect.objectContaining({ id: workspace.id, state: "current" }),
        status: expect.objectContaining({ instanceId: "instance-1" }),
      }),
    );

    const missing = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/workspaces/unknown/status", { headers }),
    );
    expect(missing.status).toBe(401);

    await handle.stop();
  });

  it("exposes explicit workspace activation without making status reads create runtimes", async () => {
    const workspace = createTestWorkspace("workspace-activation");
    const activateWorkspace = vi.fn().mockResolvedValue({
      workspaceId: workspace.id,
      state: "initializing" as const,
      message: "Workspace runtime initialization started",
    });
    const controlPlane = new ControlPlane({
      getStatus: () => createTestStatus(workspace),
      getServers: () => [],
      getSessions: () => [],
      getCurrentWorkspaceId: () => workspace.id,
      getWorkspaces: () => [workspace],
      activateWorkspace,
    });
    const credentials = new ManagementCredentialStore({
      authority: "host",
      workspaceId: workspace.id,
      generateToken: () => "activation-management-token",
    });
    const grant = credentials.issue(workspace.id);
    const managementHeaders = { Authorization: `Bearer ${grant.token}` };
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
      managementCredentials: credentials,
    });
    await handle.start();

    const unauthenticated = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/activate`, {
        method: "POST",
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const read = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/status`, {
        headers: managementHeaders,
      }),
    );
    expect(read.status).toBe(200);
    expect(activateWorkspace).not.toHaveBeenCalled();

    const activate = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/activate`, {
        method: "POST",
        headers: managementHeaders,
      }),
    );
    expect(activate.status).toBe(202);
    expect(await activate.json()).toEqual({
      workspaceId: workspace.id,
      state: "initializing",
      message: "Workspace runtime initialization started",
    });
    expect(activateWorkspace).toHaveBeenCalledWith(workspace.id);

    const wrongMethod = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/activate`, {
        headers: managementHeaders,
      }),
    );
    expect(wrongMethod.status).toBe(405);

    const unknown = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/workspaces/unknown/activate", {
        method: "POST",
        headers: managementHeaders,
      }),
    );
    expect(unknown.status).toBe(404);
    expect(activateWorkspace).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("scopes workspace routes and supports explicitly claimed handoffs", async () => {
    const currentWorkspace = createTestWorkspace("workspace-current", "2026-01-01T00:00:02.000Z");
    const otherWorkspace = createTestWorkspace("workspace-other", "2026-01-01T00:00:01.000Z");
    const workspaceStatus = (workspace: ControlPlaneWorkspace) => ({
      workspace,
      status: createTestStatus(workspace),
      servers: [],
      sessions: [],
      metrics: createTestMetrics(),
    });
    const managementTokens = ["current-management-token", "other-management-token"];
    const credentials = new ManagementCredentialStore({
      workspaceId: currentWorkspace.id,
      allowedWorkspaceIds: [otherWorkspace.id],
      generateToken: () => managementTokens.shift() ?? "unused-management-token",
    });
    const controlPlane = new ControlPlane({
      getStatus: () => createTestStatus(currentWorkspace),
      getServers: () => [],
      getSessions: () => [],
      getCurrentWorkspaceId: () => currentWorkspace.id,
      getWorkspaces: () => [currentWorkspace, otherWorkspace],
      getWorkspaceStatus: (workspaceId) =>
        workspaceId === currentWorkspace.id
          ? workspaceStatus(currentWorkspace)
          : workspaceId === otherWorkspace.id
            ? workspaceStatus(otherWorkspace)
            : null,
    });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "local-token",
      controlPlane,
      managementCredentials: credentials,
    });
    await handle.start();

    const handoffPath = `http://127.0.0.1${MANAGEMENT_CREDENTIAL_HANDOFF_PATH}`;
    const currentHandoff = await fetchHandler(
      new Request(handoffPath, {
        method: "POST",
        headers: { Authorization: "Bearer local-token" },
      }),
    );
    expect(currentHandoff.status).toBe(201);
    const currentGrant = await currentHandoff.json();
    expect(currentGrant.workspaceId).toBe(currentWorkspace.id);

    const currentHeaders = { Authorization: `Bearer ${currentGrant.token}` };
    const currentInventory = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/workspaces", { headers: currentHeaders }),
    );
    expect(currentInventory.status).toBe(401);

    const currentServers = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${currentWorkspace.id}/servers`, {
        headers: currentHeaders,
      }),
    );
    expect(currentServers.status).toBe(200);

    const otherWithCurrentGrant = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/status`, {
        headers: currentHeaders,
      }),
    );
    expect(otherWithCurrentGrant.status).toBe(401);

    const rootOtherStatus = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/status`, {
        headers: { Authorization: "Bearer local-token" },
      }),
    );
    expect(rootOtherStatus.status).toBe(401);

    const otherHandoff = await fetchHandler(
      new Request(handoffPath, {
        method: "POST",
        headers: {
          Authorization: "Bearer local-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId: otherWorkspace.id }),
      }),
    );
    expect(otherHandoff.status).toBe(201);
    const otherGrant = await otherHandoff.json();
    expect(otherGrant.workspaceId).toBe(otherWorkspace.id);

    const otherHeaders = { Authorization: `Bearer ${otherGrant.token}` };
    const otherUnqualifiedStatus = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status", { headers: otherHeaders }),
    );
    expect(otherUnqualifiedStatus.status).toBe(401);

    const otherStatus = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/status`, {
        headers: otherHeaders,
      }),
    );
    expect(otherStatus.status).toBe(200);

    const otherServers = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/servers`, {
        headers: otherHeaders,
      }),
    );
    expect(otherServers.status).toBe(200);

    await handle.stop();
  });

  it("allows a host grant to read and mutate every registered workspace", async () => {
    const currentWorkspace = createTestWorkspace("workspace-host-current", "2026-01-01T00:00:02.000Z");
    const otherWorkspace = createTestWorkspace("workspace-host-other", "2026-01-01T00:00:01.000Z");
    const workspaceStatus = (workspace: ControlPlaneWorkspace) => ({
      workspace,
      status: createTestStatus(workspace),
      servers: [],
      sessions: [],
      metrics: createTestMetrics(),
    });
    const updateServer = vi.fn().mockResolvedValue({
      accepted: true,
      changed: true,
      mutationId: "mutation-host",
      configDigest: "b".repeat(64),
      previousConfigDigest: otherWorkspace.configDigest,
      restartState: "scheduled" as const,
      reload: {
        accepted: true,
        message: "Bearer reload-secret https://user:password@example.test/?token=secret",
        reloadId: "reload-host",
      },
    });
    const management = {
      getFeatures: vi.fn().mockResolvedValue({
        mode: "standard" as const,
        effectiveMode: "standard" as const,
        codeMode: { timeout: 30_000, allowFetch: false },
        configDigest: otherWorkspace.configDigest,
        restartState: "idle" as const,
      }),
      updateServer,
      updateFeatures: vi.fn(),
    };
    const credentials = new ManagementCredentialStore({
      authority: "host",
      workspaceId: currentWorkspace.id,
      canIssueWorkspace: (workspaceId) =>
        workspaceId === currentWorkspace.id || workspaceId === otherWorkspace.id,
      generateToken: () => "host-management-token",
    });
    const controlPlane = new ControlPlane({
      getStatus: () => createTestStatus(currentWorkspace),
      getServers: () => [],
      getSessions: () => [],
      getCurrentWorkspaceId: () => currentWorkspace.id,
      getWorkspaces: () => [currentWorkspace, otherWorkspace],
      getWorkspaceStatus: (workspaceId) =>
        workspaceId === currentWorkspace.id
          ? workspaceStatus(currentWorkspace)
          : workspaceId === otherWorkspace.id
            ? workspaceStatus(otherWorkspace)
            : null,
      getWorkspaceManagement: (workspaceId) =>
        workspaceId === currentWorkspace.id || workspaceId === otherWorkspace.id ? management : null,
      getWorkspaceEvents: (workspaceId) =>
        workspaceId === otherWorkspace.id
          ? [
              {
                id: "event-other",
                timestamp: "2026-01-01T00:00:03.000Z",
                level: "info" as const,
                type: "workspace.reload",
                message: "Bearer event-secret https://user:password@example.test/?api_key=secret",
                workspaceId,
              },
            ]
          : [],
    });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "local-token",
      controlPlane,
      managementCredentials: credentials,
    });
    await handle.start();

    const handoff = await fetchHandler(
      new Request(`http://127.0.0.1${MANAGEMENT_CREDENTIAL_HANDOFF_PATH}`, {
        method: "POST",
        headers: { Authorization: "Bearer local-token" },
      }),
    );
    expect(handoff.status).toBe(201);
    const grant = await handoff.json();
    expect(grant).toMatchObject({ authority: "host", workspaceId: currentWorkspace.id });

    const headers = {
      Authorization: `Bearer ${grant.token}`,
      "Content-Type": "application/json",
    };
    const otherStatus = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/status`, { headers }),
    );
    expect(otherStatus.status).toBe(200);

    const otherFeatures = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/features`, { headers }),
    );
    expect(otherFeatures.status).toBe(200);

    const otherServers = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/servers`, { headers }),
    );
    expect(otherServers.status).toBe(200);

    const otherSessions = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/sessions`, { headers }),
    );
    expect(otherSessions.status).toBe(200);

    const otherMetrics = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/metrics`, { headers }),
    );
    expect(otherMetrics.status).toBe(200);

    const otherEvents = await fetchHandler(
      new Request(
        `http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/events?limit=5`,
        { headers },
      ),
    );
    expect(otherEvents.status).toBe(200);
    expect((await otherEvents.json()).events).toEqual([
      expect.objectContaining({
        id: "event-other",
        workspaceId: otherWorkspace.id,
        message: "Bearer [redacted] https://[redacted]@example.test/?api_key=[redacted]",
      }),
    ]);

    const patchResponse = await fetchHandler(
      new Request(
        `http://127.0.0.1/api/v1/workspaces/${otherWorkspace.id}/servers/mcp%3Ademo`,
        {
          method: "PATCH",
          headers: { ...headers, "If-Match": otherWorkspace.configDigest },
          body: JSON.stringify({ enabled: false }),
        },
      ),
    );
    expect(patchResponse.status).toBe(202);
    expect(await patchResponse.json()).toMatchObject({
      accepted: true,
      reload: {
        accepted: true,
        message: "Bearer [redacted] https://[redacted]@example.test/?token=[redacted]",
        reloadId: "reload-host",
      },
    });
    expect(updateServer).toHaveBeenCalledWith(
      "mcp:demo",
      { enabled: false },
      otherWorkspace.configDigest,
    );

    const unknown = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/workspaces/unknown/status", { headers }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "workspace-not-found",
      message: "Workspace is not registered with this daemon host",
    });

    await handle.stop();
  });

  it("attributes lease-bound MCP sessions to their workspace", async () => {
    const tracker = new ConnectionTracker(1_000, () => undefined, 10_000);
    const lease = tracker.acquire("lease-1", { workspaceId: "workspace-current" });
    const onSessionInitialize = vi.fn();
    const onSessionClose = vi.fn();
    const controlPlane = new ControlPlane({
      getStatus: () => createTestStatus(),
      getServers: () => [],
      getSessions: () => [],
    });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
      connectionTracker: tracker,
      onSessionInitialize,
      onSessionClose,
    });
    await handle.start();

    handle.transport.onmessage = (message) => {
      if (!("id" in message) || message.id === undefined) return;
      void handle.transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
    };

    const sessionId = "session-workspace-current";
    const contextHeaders = {
      Authorization: "Bearer secret",
      [DAEMON_BRIDGE_LEASE_HEADER]: lease.leaseId,
      [DAEMON_WORKSPACE_HEADER]: "spoofed-workspace-should-not-win",
      "Mcp-Session-Id": sessionId,
      "Content-Type": "application/json",
    };
    const initialize = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: contextHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "workspace-client", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get(DAEMON_BRIDGE_LEASE_HEADER)).toBe(lease.leaseId);
    expect(initialize.headers.get(DAEMON_WORKSPACE_HEADER)).toBe("workspace-current");
    expect(onSessionInitialize).toHaveBeenCalledWith(
      sessionId,
      { name: "workspace-client", version: "1.0.0" },
      { leaseId: lease.leaseId, workspaceId: "workspace-current" },
    );

    const nextRequest = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Mcp-Session-Id": sessionId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      }),
    );
    expect(nextRequest.headers.get(DAEMON_WORKSPACE_HEADER)).toBe("workspace-current");

    const close = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "DELETE",
        headers: { Authorization: "Bearer secret", "Mcp-Session-Id": sessionId },
      }),
    );
    expect(close.status).toBe(204);
    expect(close.headers.get(DAEMON_BRIDGE_LEASE_HEADER)).toBe(lease.leaseId);
    expect(close.headers.get(DAEMON_WORKSPACE_HEADER)).toBe("workspace-current");
    expect(onSessionClose).toHaveBeenCalledWith(sessionId, {
      leaseId: lease.leaseId,
      workspaceId: "workspace-current",
    });

    await handle.stop();
    tracker.destroy();
  });

  it("rejects oversized chunked MCP and management handoff bodies", async () => {
    const credentials = new ManagementCredentialStore({ generateToken: () => "management-token" });
    const controlPlane = new ControlPlane({
      getStatus: () => createTestStatus(),
      getServers: () => [],
      getSessions: () => [],
    });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "local-token",
      controlPlane,
      managementCredentials: credentials,
    });
    await handle.start();

    const oversizedBytes = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(MANAGEMENT_BODY_LIMIT_BYTES) }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedBytes);
        controller.close();
      },
    });
    const oversizedMcp = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer local-token", "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(oversizedMcp.status).toBe(413);
    expect((await oversizedMcp.json()).error.message).toBe("MCP request body is too large");

    const oversizedHandoff = await fetchHandler(
      new Request(`http://127.0.0.1${MANAGEMENT_CREDENTIAL_HANDOFF_PATH}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer local-token",
          "Content-Length": "4097",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(oversizedHandoff.status).toBe(413);
    expect(credentials.size).toBe(0);

    await handle.stop();
  });
});

describe("createHttpServerTransport management handoff route", () => {
  let fetchHandler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serve).mockImplementation((options: ServeOptions) => {
      fetchHandler = options.fetch;
      return {
        port: options.port,
        ready: Promise.resolve(options.port),
        stop: vi.fn(),
      };
    });
  });

  afterEach(() => {
    fetchHandler = undefined as never;
  });

  it("mints a separate browser credential and limits it to control-plane routes", async () => {
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
        uptimeSeconds: 1,
      }),
      getServers: () => [],
      getSessions: () => [],
    });
    const credentials = new ManagementCredentialStore({
      generateToken: () => "management-token",
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "local-token",
      controlPlane,
      managementCredentials: credentials,
    });
    await handle.start();

    const handoffUrl = `http://127.0.0.1${MANAGEMENT_CREDENTIAL_HANDOFF_PATH}`;
    const unauthorized = await fetchHandler(new Request(handoffUrl, { method: "POST" }));
    expect(unauthorized.status).toBe(401);

    const handoff = await fetchHandler(
      new Request(handoffUrl, {
        method: "POST",
        headers: { Authorization: "Bearer local-token" },
      }),
    );
    expect(handoff.status).toBe(201);
    const grant = await handoff.json();
    expect(grant).toMatchObject({
      token: "management-token",
      scope: "management",
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(grant)).not.toContain("local-token");

    const managementHeaders = { Authorization: "Bearer management-token" };
    const status = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/status", { headers: managementHeaders }),
    );
    expect(status.status).toBe(200);

    const health = await fetchHandler(
      new Request("http://127.0.0.1/api/v1/health", { headers: managementHeaders }),
    );
    expect(health.status).toBe(401);

    const mcp = await fetchHandler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { ...managementHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(mcp.status).toBe(401);

    const cannotMint = await fetchHandler(
      new Request(handoffUrl, { method: "POST", headers: managementHeaders }),
    );
    expect(cannotMint.status).toBe(401);

    const queryHandoff = await fetchHandler(
      new Request(`${handoffUrl}?unexpected=true`, {
        method: "POST",
        headers: { Authorization: "Bearer local-token" },
      }),
    );
    expect(queryHandoff.status).toBe(400);
    expect(credentials.size).toBe(1);

    await handle.stop();
    expect(credentials.size).toBe(0);
  });

  it("does not expose a handoff route when no local root credential is configured", async () => {
    const credentials = new ManagementCredentialStore({ generateToken: () => "management-token" });
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      controlPlane: new ControlPlane({
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
          uptimeSeconds: 1,
        }),
        getServers: () => [],
        getSessions: () => [],
      }),
      managementCredentials: credentials,
    });
    await handle.start();

    const response = await fetchHandler(
      new Request(`http://127.0.0.1${MANAGEMENT_CREDENTIAL_HANDOFF_PATH}`, { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(credentials.size).toBe(0);

    await handle.stop();
  });
});

function createTestWorkspace(
  id: string,
  lastSeenAt = "2026-01-01T00:00:00.000Z",
): ControlPlaneWorkspace {
  return {
    id,
    directory: `/tmp/${id}`,
    configPath: `/tmp/${id}/routermcp.jsonc`,
    configScope: "project-local",
    profileId: `${id}-profile`,
    configDigest: "a".repeat(64),
    state: "known",
    activeConnections: 0,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
  };
}

function createTestStatus(workspace?: ControlPlaneWorkspace): ControlPlaneStatus {
  return {
    state: "ready",
    instanceId: "instance-1",
    version: "0.2.1",
    protocolVersion: "1",
    profile: workspace?.profileId ?? "profile-1",
    configDigest: workspace?.configDigest ?? "a".repeat(64),
    host: "127.0.0.1",
    port: 7858,
    mcpUrl: "http://127.0.0.1:7858/mcp",
    controlUrl: "http://127.0.0.1:7858",
    startedAt: "2026-01-01T00:00:00.000Z",
    uptimeSeconds: 1,
    ...(workspace
      ? {
          workspaceId: workspace.id,
          workspaceDirectory: workspace.directory,
          workspaceConfigPath: workspace.configPath,
        }
      : {}),
  };
}

function createTestMetrics(): ControlPlaneMetrics {
  return {
    requestsTotal: 0,
    requestsPerSecond: 0,
    errorsTotal: 0,
    errorRate: 0,
    toolCallsTotal: 0,
    activeSessions: 0,
    activeLeases: 0,
    latencyMs: { p50: 0, p95: 0, p99: 0 },
  };
}
