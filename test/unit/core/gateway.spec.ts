import { describe, expect, it } from "vitest";
import type { RouterMcpConfig } from "../../../src/config/types.js";
import { createGateway, mergeUpstreamServerHealth } from "../../../src/core/gateway.js";
import type { UpstreamServer } from "../../../src/core/upstream.js";
import { VirtualSessionManager } from "../../../src/core/virtual-session.js";

const config: RouterMcpConfig = {
  mcpServers: {
    test: { transport: "stdio", command: "test" },
  },
};

function createServer(
  overrides: Partial<UpstreamServer> = {},
): UpstreamServer {
  return {
    name: "test",
    config: config.mcpServers.test,
    status: "discovered",
    client: null,
    cleanup: null,
    error: null,
    tools: [],
    resources: [],
    prompts: [],
    cachedTools: [],
    cachedResources: [],
    cachedPrompts: [],
    lastActivity: null,
    lastCheckedAt: null,
    lastLatencyMs: null,
    idleTimer: null,
    connectionPromise: null,
    ...overrides,
  };
}

describe("mergeUpstreamServerHealth", () => {
  it("lets a newer on-demand connection replace a stale discovery error", () => {
    const startupError = new Error("server was unavailable during startup");
    const merged = mergeUpstreamServerHealth(
      createServer({ status: "error", error: startupError, lastCheckedAt: 100 }),
      createServer({ status: "connected", lastCheckedAt: 200, lastLatencyMs: 12 }),
    );

    expect(merged.status).toBe("connected");
    expect(merged.error).toBeNull();
    expect(merged.lastCheckedAt).toBe(200);
    expect(merged.lastLatencyMs).toBe(12);
  });

  it("retains a newer on-demand failure over an older cached discovery result", () => {
    const failure = new Error("connection refused");
    const merged = mergeUpstreamServerHealth(
      createServer({ status: "discovered", lastCheckedAt: 100, cachedTools: [{ name: "tool" }] }),
      createServer({ status: "error", error: failure, lastCheckedAt: 200, lastLatencyMs: 25 }),
    );

    expect(merged.status).toBe("error");
    expect(merged.error).toBe(failure);
    expect(merged.lastCheckedAt).toBe(200);
    expect(merged.lastLatencyMs).toBe(25);
  });

  it("keeps an aggregate failure when another active session is connected", async () => {
    const gateway = createGateway({ config, mode: "stdio" });
    const sessions = new VirtualSessionManager({
      config,
      sessionTimeout: 60,
      maxSessions: 5,
    });
    const connected = sessions.getOrCreate("connected").upstreamManager.get("test");
    const failed = sessions.getOrCreate("failed").upstreamManager.get("test");
    if (!connected || !failed) throw new Error("Expected test upstream records");

    Object.assign(connected, {
      status: "connected" as const,
      lastCheckedAt: 200,
      cachedTools: [{ name: "tool", description: "tool", inputSchema: { type: "object" } }],
    });
    Object.assign(failed, {
      status: "error" as const,
      error: new Error("connection refused"),
      lastCheckedAt: 100,
    });

    (gateway as unknown as { sessionManager: VirtualSessionManager }).sessionManager = sessions;

    expect(gateway.getUpstreamServers()[0]?.status).toBe("error");

    await sessions.cleanupAll();
  });
});

describe("embedded gateway transport", () => {
  it("dispatches requests without binding stdio or an HTTP listener", async () => {
    const gateway = createGateway({ config: { mcpServers: {} }, mode: "embedded" });

    await gateway.start();
    try {
      const response = await gateway.handleRequestWithSession(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
                clientInfo: { name: "embedded-test", version: "1.0.0" },
          },
        },
        "session-a",
      );

      expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
      expect(response && "result" in response).toBe(true);
    } finally {
      await gateway.stop();
    }
  });

  it("keeps duplicate request IDs isolated across sessions", async () => {
    const gateway = createGateway({ config: { mcpServers: {} }, mode: "embedded" });

    await gateway.start();
    try {
      const responses = await Promise.all(
        ["session-a", "session-b"].map((sessionId) =>
          gateway.handleRequestWithSession(
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: sessionId, version: "1.0.0" },
              },
            },
            sessionId,
          ),
        ),
      );

      expect(responses).toHaveLength(2);
      expect(responses.map((response) => response && "id" in response && response.id)).toEqual([
        1,
        1,
      ]);

      const listResponses = await Promise.all(
        ["session-a", "session-b"].map((sessionId) =>
          gateway.handleRequestWithSession(
            { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
            sessionId,
          ),
        ),
      );
      expect(listResponses).toHaveLength(2);
      expect(listResponses.every((response) => response && "result" in response)).toBe(true);
      expect(gateway.getSessionStats()?.activeSessions).toBe(2);
    } finally {
      await gateway.stop();
    }
  });
});
