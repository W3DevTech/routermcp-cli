import { describe, expect, it, vi } from "vitest";
import {
  boundEventLimit,
  ControlPlane,
  type ControlPlaneServer,
  type ControlPlaneStatus,
  type ControlPlaneWorkspace,
  sanitizeText,
  sanitizeUrl,
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
      getSessions: () => [
        {
          id: "session",
          kind: "mcp",
          state: "active",
          connectedAt: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
        },
      ],
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

  it("deduplicates concurrent workspace activation and rejects unknown workspaces", async () => {
    const workspace: ControlPlaneWorkspace = {
      id: "workspace-activation",
      directory: "/tmp/workspace-activation",
      configPath: "/tmp/workspace-activation/routermcp.jsonc",
      configScope: "project-local",
      profileId: "profile-activation",
      configDigest: "a".repeat(64),
      state: "known",
      activeConnections: 0,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    let resolveActivation!: (value: {
      workspaceId: string;
      state: "ready";
      message: string;
    }) => void;
    const activateWorkspace = vi.fn(
      () =>
        new Promise<{
          workspaceId: string;
          state: "ready";
          message: string;
        }>((resolve) => {
          resolveActivation = resolve;
        }),
    );
    const controlPlane = new ControlPlane({
      getStatus: () => ({
        state: "ready",
        instanceId: "instance",
        version: "0.2.1",
        protocolVersion: "1",
        profile: workspace.profileId,
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
      getWorkspaces: () => [workspace],
      activateWorkspace,
    });

    const first = controlPlane.activateWorkspace(workspace.id);
    const second = controlPlane.activateWorkspace(workspace.id);
    await vi.waitFor(() => expect(activateWorkspace).toHaveBeenCalledTimes(1));
    resolveActivation({
      workspaceId: workspace.id,
      state: "ready",
      message: "ready",
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { workspaceId: workspace.id, state: "ready", message: "ready" },
      { workspaceId: workspace.id, state: "ready", message: "ready" },
    ]);

    await expect(controlPlane.activateWorkspace("unknown")).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
  });

  it("keeps workspace snapshots and mutations scoped to the requested claim", async () => {
    const workspaceA: ControlPlaneWorkspace = {
      id: "workspace-a",
      directory: "/tmp/project-a",
      configPath: "/tmp/project-a/routermcp.jsonc",
      configScope: "project-local",
      profileId: "profile-a",
      configDigest: "a".repeat(64),
      state: "current",
      activeConnections: 1,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const workspaceB: ControlPlaneWorkspace = {
      ...workspaceA,
      id: "workspace-b",
      directory: "/tmp/project-b",
      configPath: "/tmp/project-b/routermcp.jsonc",
      profileId: "profile-b",
      configDigest: "b".repeat(64),
      state: "known",
      activeConnections: 0,
    };
    const features = {
      mode: "standard" as const,
      effectiveMode: "standard" as const,
      codeMode: { timeout: 30_000, allowFetch: false },
      configDigest: workspaceA.configDigest,
      restartState: "idle" as const,
    };
    const server: ControlPlaneServer = {
      id: "mcp:demo",
      name: "demo",
      kind: "mcp",
      enabled: true,
      observedState: "online",
      configRevision: workspaceA.configDigest,
      lastChangedAt: "2026-01-01T00:00:00.000Z",
      state: "online",
      toolCount: 2,
    };
    const management = {
      getFeatures: vi.fn().mockResolvedValue(features),
      updateServer: vi.fn().mockResolvedValue({
        accepted: true,
        changed: true,
        mutationId: "mutation-1",
        configDigest: "c".repeat(64),
        previousConfigDigest: workspaceA.configDigest,
        restartState: "scheduled" as const,
      }),
      updateFeatures: vi.fn(),
    };
    const status: ControlPlaneStatus = {
      state: "ready",
      instanceId: "instance-a",
      version: "0.2.1",
      protocolVersion: "1",
      profile: workspaceA.profileId,
      configDigest: workspaceA.configDigest,
      host: "127.0.0.1",
      port: 7858,
      mcpUrl: "http://127.0.0.1:7858/mcp",
      controlUrl: "http://127.0.0.1:7858",
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeSeconds: 1,
      workspaceId: workspaceA.id,
    };
    const controlPlane = new ControlPlane({
      getStatus: () => status,
      getServers: () => [server],
      getSessions: () => [],
      getCurrentWorkspaceId: () => workspaceA.id,
      getWorkspaces: () => [workspaceA, workspaceB],
      getWorkspaceStatus: (workspaceId) =>
        workspaceId === workspaceA.id
          ? {
              workspace: workspaceA,
              status,
              servers: [server],
              sessions: [],
              metrics: emptyMetrics(),
              features,
            }
          : null,
      getWorkspaceManagement: (workspaceId) => (workspaceId === workspaceA.id ? management : null),
    });

    expect(controlPlane.getCurrentWorkspaceId()).toBe(workspaceA.id);
    expect(controlPlane.getWorkspaceManagement(workspaceB.id)).toBeNull();
    expect(controlPlane.getWorkspaceManagement("workspace/a")).toBeNull();
    expect(controlPlane.getWorkspaceServers(workspaceA.id)).toEqual([
      expect.objectContaining({
        id: server.id,
        enabled: true,
        observedState: "online",
        configRevision: workspaceA.configDigest,
      }),
    ]);
    expect(await controlPlane.getWorkspaceFeatures(workspaceA.id)).toEqual(features);
    expect(await controlPlane.getWorkspaceSnapshot(workspaceA.id)).toEqual(
      expect.objectContaining({ features }),
    );

    await expect(
      controlPlane.updateWorkspaceServer(
        workspaceA.id,
        server.id,
        { enabled: false },
        workspaceA.configDigest,
      ),
    ).resolves.toMatchObject({ accepted: true, changed: true });
    expect(management.updateServer).toHaveBeenCalledWith(
      server.id,
      { enabled: false },
      workspaceA.configDigest,
    );
    await expect(
      controlPlane.updateWorkspaceServer(
        workspaceB.id,
        server.id,
        { enabled: false },
        workspaceB.configDigest,
      ),
    ).resolves.toMatchObject({ accepted: false, changed: false });
    expect(management.updateServer).toHaveBeenCalledTimes(1);
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

function emptyMetrics() {
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

describe("control-plane redaction helpers", () => {
  it("removes bearer, URL credential, and query secret material", () => {
    const value = sanitizeText(
      "Bearer token https://user:password@example.com/mcp?api_key=secret&x=1",
    );
    expect(value).toBe(
      "Bearer [redacted] https://[redacted]@example.com/mcp?api_key=[redacted]&x=1",
    );
    expect(sanitizeUrl("https://user:password@example.com/mcp?token=secret")).toBe(
      "https://example.com/mcp",
    );
  });

  it("replaces control characters before returning browser-visible text", () => {
    expect(sanitizeText("line\u0000break\u001f \u007f")).toBe("line break   ");
  });

  it("bounds event limits to a safe range", () => {
    expect(boundEventLimit(Number.NaN)).toBe(40);
    expect(boundEventLimit(0)).toBe(1);
    expect(boundEventLimit(9.8)).toBe(9);
    expect(boundEventLimit(999)).toBe(200);
  });
});
