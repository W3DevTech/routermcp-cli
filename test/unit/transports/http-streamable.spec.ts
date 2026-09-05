import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { serve, type ServeOptions } from "../../../src/compat/index.js";
import { ConnectionTracker } from "../../../src/daemon/connection-tracker.js";
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
});
