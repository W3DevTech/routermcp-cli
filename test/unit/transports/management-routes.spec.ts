import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { serve, type ServeOptions } from "../../../src/compat/index.js";
import {
  ControlPlane,
  createConfigManagementSource,
  ManagementCredentialStore,
  readConfigSnapshot,
} from "../../../src/control-plane/index.js";
import { createHttpServerTransport } from "../../../src/transports/http-streamable.js";
import { cleanupTempDir, createTempDir, writeConfigFile } from "../../helpers/test-utils.js";

describe("control-plane management routes", () => {
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

  it("mounts feature GET/PATCH and validates mode changes", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      });
      const restart = vi.fn().mockResolvedValue({
        accepted: true,
        message: "restart scheduled",
        state: "stopping" as const,
      });
      const management = createConfigManagementSource({
        getConfigPath: () => configPath,
        restart,
      });
      const controlPlane = createControlPlane(management);
      const handle = createHttpServerTransport(7858, "127.0.0.1", {
        authToken: "secret",
        controlPlane,
      });
      await handle.start();

      const headers = { Authorization: "Bearer secret" };
      expect(
        (await fetchHandler(new Request("http://127.0.0.1/api/v1/features", { headers }))).status,
      ).toBe(200);
      const initial = await (await fetchHandler(
        new Request("http://127.0.0.1/api/v1/features", { headers }),
      )).json();
      const digest = initial.features.configDigest as string;

      const missingDigest = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/features", {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "code" }),
        }),
      );
      expect(missingDigest.status).toBe(428);

      const invalid = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/features", {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json", "If-Match": digest },
          body: JSON.stringify({ mode: "code", codeMode: { timeout: 999 } }),
        }),
      );
      expect(invalid.status).toBe(400);

      const updated = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/features", {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json", "If-Match": digest },
          body: JSON.stringify({ mode: "code", codeMode: { timeout: 5_000 } }),
        }),
      );
      expect(updated.status).toBe(202);
      expect(await updated.json()).toMatchObject({
        mutation: {
          accepted: true,
          changed: true,
          restartState: "scheduled",
        },
      });
      expect(restart).toHaveBeenCalledTimes(1);

      await handle.stop();
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("requires prefixed server IDs and returns current digest on conflicts", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      });
      const restart = vi.fn().mockResolvedValue({ accepted: true, message: "scheduled" });
      const management = createConfigManagementSource({ getConfigPath: () => configPath, restart });
      const controlPlane = createControlPlane(management);
      const handle = createHttpServerTransport(7858, "127.0.0.1", {
        authToken: "secret",
        controlPlane,
      });
      await handle.start();
      const headers = { Authorization: "Bearer secret", "Content-Type": "application/json" };
      const initial = await readConfigSnapshot(configPath);

      const unprefixed = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/servers/demo", {
          method: "PATCH",
          headers: { ...headers, "If-Match": initial.digest },
          body: JSON.stringify({ enabled: false }),
        }),
      );
      expect(unprefixed.status).toBe(400);

      const valid = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/servers/mcp%3Ademo", {
          method: "PATCH",
          headers: { ...headers, "If-Match": initial.digest },
          body: JSON.stringify({ enabled: false }),
        }),
      );
      expect(valid.status).toBe(202);
      const mutation = await valid.json();
      const currentDigest = mutation.mutation.configDigest as string;

      const conflict = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/servers/mcp%3Ademo", {
          method: "PATCH",
          headers: { ...headers, "If-Match": initial.digest },
          body: JSON.stringify({ enabled: true }),
        }),
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        error: "conflict",
        currentDigest,
      });
      expect(restart).toHaveBeenCalledTimes(1);

      await handle.stop();
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("routes management-authenticated MCP traffic to the URL workspace", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      });
      const management = createConfigManagementSource({ getConfigPath: () => configPath });
      const controlPlane = createControlPlane(management, ["workspace-current", "workspace-other"]);
      const credentials = new ManagementCredentialStore({
        authority: "host",
        generateToken: () => "management-token",
      });
      credentials.issue();
      const dispatchMcp = vi.fn(async (message, _sessionId, context) => ({
        jsonrpc: "2.0" as const,
        id: "id" in message ? message.id : null,
        result: {
          workspaceId: context?.workspaceId,
          ...(message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "test-server", version: "1.0.0" },
              }
            : {}),
        },
      }));
      const onSessionInitialize = vi.fn();
      const onSessionClose = vi.fn();
      const handle = createHttpServerTransport(7858, "127.0.0.1", {
        authToken: "local-secret",
        controlPlane,
        managementCredentials: credentials,
        dispatchMcp,
        onSessionInitialize,
        onSessionClose,
      });
      await handle.start();

      const authorization = { Authorization: "Bearer management-token" };
      const initialized = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/workspaces/workspace-current/mcp", {
          method: "POST",
          headers: { ...authorization, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "test-client", version: "1.0.0" } },
          }),
        }),
      );
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      expect(await initialized.json()).toMatchObject({ result: { workspaceId: "workspace-current" } });
      expect(dispatchMcp).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: "initialize" }),
        sessionId,
        { workspaceId: "workspace-current" },
      );
      expect(onSessionInitialize).toHaveBeenCalledWith(
        sessionId,
        { name: "test-client", version: "1.0.0" },
        { workspaceId: "workspace-current" },
      );

      const crossWorkspace = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/workspaces/workspace-other/mcp", {
          method: "POST",
          headers: {
            ...authorization,
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId as string,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        }),
      );
      expect(crossWorkspace.status).toBe(400);
      expect(dispatchMcp).toHaveBeenCalledTimes(1);

      const otherWorkspace = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/workspaces/workspace-other/mcp", {
          method: "POST",
          headers: { ...authorization, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
        }),
      );
      expect(otherWorkspace.status).toBe(200);
      expect(await otherWorkspace.json()).toMatchObject({ result: { workspaceId: "workspace-other" } });

      const closed = await fetchHandler(
        new Request("http://127.0.0.1/api/v1/workspaces/workspace-current/mcp", {
          method: "DELETE",
          headers: { ...authorization, "Mcp-Session-Id": sessionId as string },
        }),
      );
      expect(closed.status).toBe(204);
      expect(onSessionClose).toHaveBeenCalledWith(sessionId, { workspaceId: "workspace-current" });

      await handle.stop();
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("does not let management grants use the shared bridge MCP route", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      });
      const management = createConfigManagementSource({ getConfigPath: () => configPath });
      const credentials = new ManagementCredentialStore({
        authority: "host",
        generateToken: () => "management-token",
      });
      credentials.issue();
      const handle = createHttpServerTransport(7858, "127.0.0.1", {
        authToken: "local-secret",
        controlPlane: createControlPlane(management, ["workspace-current"]),
        managementCredentials: credentials,
        dispatchMcp: vi.fn(),
      });
      await handle.start();

      const response = await fetchHandler(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            Authorization: "Bearer management-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(response.status).toBe(401);
      await handle.stop();
    } finally {
      await cleanupTempDir(directory);
    }
  });
});

function createControlPlane(
  management: ReturnType<typeof createConfigManagementSource>,
  workspaceIds: string[] = ["workspace-current"],
): ControlPlane {
  return new ControlPlane({
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
    getWorkspaces: () => workspaceIds.map((id) => ({
      id,
      directory: `/tmp/${id}`,
      configPath: `/tmp/${id}/routermcp.jsonc`,
      configScope: "project-local" as const,
      profileId: id,
      configDigest: "a".repeat(64),
      state: "known" as const,
      activeConnections: 0,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    })),
    getCurrentWorkspaceId: () => "workspace-current",
    management,
  });
}
