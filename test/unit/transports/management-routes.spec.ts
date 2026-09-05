import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { serve, type ServeOptions } from "../../../src/compat/index.js";
import {
  ControlPlane,
  createConfigManagementSource,
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
});

function createControlPlane(
  management: ReturnType<typeof createConfigManagementSource>,
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
    management,
  });
}
