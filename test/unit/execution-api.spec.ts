import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/compat/index.js", () => ({ serve: vi.fn() }));

import { serve, type ServeOptions } from "../../src/compat/index.js";
import { ControlPlane, type ControlPlaneWorkspace } from "../../src/control-plane/index.js";
import { ExecutionService } from "../../src/core/execution-service.js";
import { createHttpServerTransport } from "../../src/transports/http-streamable.js";

describe("workspace execution control routes", () => {
  let fetchHandler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    vi.mocked(serve).mockImplementation((options: ServeOptions) => {
      fetchHandler = options.fetch;
      return { port: options.port, ready: Promise.resolve(options.port), stop: vi.fn() };
    });
  });

  afterEach(() => {
    fetchHandler = undefined as never;
    vi.clearAllMocks();
  });

  it("returns a callable collision identity from search and accepts it for execution", async () => {
    const { service, callTool } = createCollisionExecutionService();

    const search = service.searchTools("resolve Acme billing invoice");

    await service.callTool("session-a", search.topTool ?? "", {});

    expect(callTool).toHaveBeenCalledWith("session-a", "lookup_0abc", {});
    expect(search.topTool).toBe("lookup_0abc");
    expect(search.candidates[0]).toMatchObject({
      name: "lookup_0abc",
      originalName: "lookup",
      serverName: "beta",
    });
  });

  it("retains upstream metadata and exposes callableName in daemon discovery", () => {
    const { service } = createCollisionExecutionService();

    expect(service.listTools().tools.find((tool) => tool.serverName === "beta")).toMatchObject({
      name: "lookup",
      callableName: "lookup_0abc",
      serverName: "beta",
    });
  });

  it("returns an empty result when no tool has a positive score", () => {
    const service = new ExecutionService({
      getCapabilities: () => ({
        tools: new Map([
          [
            "weather",
            {
              serverName: "weather",
              tool: { name: "weather", description: "Forecast", inputSchema: { type: "object" } },
            },
          ],
        ]),
        resources: new Map(),
        prompts: new Map(),
        serverCapabilities: new Map(),
      }),
      getSession: () => ({}) as never,
      callTool: async () => ({ content: [] }),
      getCodeModeConfig: () => ({ enabled: false }),
      getToolSearchConfig: () => ({ enabled: true, minScore: 0 }),
    });

    expect(service.searchTools("zzzxqv")).toMatchObject({
      topTool: null,
      candidates: [],
    });
  });

  it("lists tools, queues calls, and scopes jobs to the workspace", async () => {
    const workspace = createWorkspace();
    const service = new ExecutionService({
      getCapabilities: () => ({
        tools: new Map([
          ["echo", { serverName: "local", tool: { name: "echo", inputSchema: { type: "object" } } }],
        ]),
        resources: new Map(),
        prompts: new Map(),
        serverCapabilities: new Map(),
      }),
      getSession: () => ({}) as never,
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      getCodeModeConfig: () => ({ enabled: false }),
      getToolSearchConfig: () => ({ enabled: false }),
    });
    const controlPlane = createControlPlane(workspace, service);
    const handle = createHttpServerTransport(7858, "127.0.0.1", {
      authToken: "secret",
      controlPlane,
    });
    await handle.start();

    const base = `http://127.0.0.1/api/v1/workspaces/${workspace.id}`;
    const toolsResponse = await fetchHandler(
      new Request(`${base}/tools`, { headers: { Authorization: "Bearer secret" } }),
    );
    expect(toolsResponse.status).toBe(200);
    expect((await toolsResponse.json()).tools).toEqual([
      expect.objectContaining({ name: "echo", serverName: "local" }),
    ]);

    const callResponse = await fetchHandler(
      new Request(`${base}/tool-calls`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "echo", arguments: {} }),
      }),
    );
    expect(callResponse.status).toBe(202);
    const jobId = (await callResponse.json()).job.id;

    await vi.waitFor(async () => {
      const poll = await fetchHandler(
        new Request(`${base}/jobs/${jobId}`, { headers: { Authorization: "Bearer secret" } }),
      );
      expect((await poll.json()).job).toMatchObject({ state: "succeeded", result: { content: [{ text: "ok" }] } });
    });

    const crossWorkspace = await fetchHandler(
      new Request(`${base}/jobs/${jobId}`, {
        headers: { Authorization: "Bearer secret", "X-RouterMCP-Workspace-Id": "other" },
      }),
    );
    expect(crossWorkspace.status).toBe(200);
  });

  it("rejects code execution when the workspace has Code Mode disabled", async () => {
    const workspace = createWorkspace();
    const service = new ExecutionService({
      getCapabilities: () => ({ tools: new Map(), resources: new Map(), prompts: new Map(), serverCapabilities: new Map() }),
      getSession: () => ({}) as never,
      callTool: async () => ({ content: [] }),
      getCodeModeConfig: () => ({ enabled: false }),
      getToolSearchConfig: () => undefined,
    });
    const controlPlane = createControlPlane(workspace, service);
    const handle = createHttpServerTransport(7858, "127.0.0.1", { authToken: "secret", controlPlane });
    await handle.start();

    const response = await fetchHandler(
      new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/code-runs`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ code: "return 1" }),
      }),
    );
    expect(response.status).toBe(202);
    const jobId = (await response.json()).job.id;
    await vi.waitFor(async () => {
      const poll = await fetchHandler(
        new Request(`http://127.0.0.1/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, {
          headers: { Authorization: "Bearer secret" },
        }),
      );
      expect((await poll.json()).job).toMatchObject({ state: "failed", error: { code: "feature-disabled" } });
    });
  });
});

function createCollisionExecutionService(): {
  service: ExecutionService;
  callTool: ReturnType<typeof vi.fn>;
} {
  const tools = new Map([
    [
      "lookup",
      {
        serverName: "alpha",
        tool: {
          name: "lookup",
          description: "Find an internal support request",
          inputSchema: { type: "object" },
        },
      },
    ],
    [
      "lookup_0abc",
      {
        serverName: "beta",
        tool: {
          name: "lookup",
          description: "Resolve Acme billing invoices and payment status",
          inputSchema: { type: "object" },
        },
      },
    ],
  ]);
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "beta result" }] }));
  const service = new ExecutionService({
    getCapabilities: () => ({
      tools,
      resources: new Map(),
      prompts: new Map(),
      serverCapabilities: new Map(),
    }),
    getSession: () => ({}) as never,
    callTool,
    getCodeModeConfig: () => ({ enabled: false }),
    getToolSearchConfig: () => ({ enabled: true, minScore: 0 }),
  });

  return { service, callTool };
}

function createControlPlane(workspace: ControlPlaneWorkspace, service: ExecutionService): ControlPlane {
  return new ControlPlane({
    getStatus: () => ({
      state: "ready",
      instanceId: "instance",
      version: "0.2.1",
      protocolVersion: "1",
      profile: "profile",
      configDigest: "a".repeat(64),
      host: "127.0.0.1",
      port: 7858,
      mcpUrl: "http://127.0.0.1:7858/mcp",
      controlUrl: "http://127.0.0.1:7858",
      startedAt: new Date().toISOString(),
      uptimeSeconds: 1,
    }),
    getServers: () => [],
    getSessions: () => [],
    getWorkspaces: () => [workspace],
    getCurrentWorkspaceId: () => workspace.id,
    execution: { getWorkspaceExecution: () => service },
  });
}

function createWorkspace(): ControlPlaneWorkspace {
  return {
    id: "workspace-a",
    directory: "/tmp/workspace-a",
    configPath: "/tmp/workspace-a/routermcp.jsonc",
    configScope: "project-local",
    profileId: "profile-a",
    configDigest: "a".repeat(64),
    state: "current",
    activeConnections: 0,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}
