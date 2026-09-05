import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createConfigManagementSource,
  readConfigSnapshot,
  type ControlPlaneManagementRestartResult,
} from "../../src/control-plane/index.js";
import { cleanupTempDir, createTempDir, writeConfigFile } from "../helpers/test-utils.js";

describe("context-scoped config management source", () => {
  it("reads desired mode from the selected config and schedules a sanitized restart", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      });
      const restart = vi.fn<() => Promise<ControlPlaneManagementRestartResult>>().mockResolvedValue({
        accepted: true,
        message: "restart scheduled",
        state: "stopping",
        restartId: "restart-1",
      });
      const onAuditEvent = vi.fn();
      const source = createConfigManagementSource({
        getConfigPath: () => configPath,
        getEffectiveMode: () => "standard",
        restart,
        onAuditEvent,
      });

      const initial = await source.getFeatures();
      const initialDigest = initial.configDigest;
      expect(initial).toMatchObject({
        mode: "standard",
        effectiveMode: "standard",
        configDigest: expect.any(String),
        restartState: "idle",
      });

      const mutation = await source.updateFeatures(
        { mode: "code", codeMode: { timeout: 20_000, allowFetch: false } },
        initialDigest,
      );
      expect(mutation).toMatchObject({
        accepted: true,
        changed: true,
        restartState: "scheduled",
        restart: { accepted: true, restartId: "restart-1" },
      });
      expect(restart).toHaveBeenCalledTimes(1);
      expect(onAuditEvent).toHaveBeenCalledWith({
        type: "features.mode",
        message: "Execution mode updated",
        metadata: expect.objectContaining({
          mode: "code",
          previousMode: "standard",
          changed: true,
          mutationId: expect.any(String),
          configRevision: expect.any(String),
          restartState: "scheduled",
        }),
      });
      expect(JSON.stringify(onAuditEvent.mock.calls)).not.toContain("routermcp.jsonc");

      const updated = await source.getFeatures();
      expect(updated).toMatchObject({
        mode: "code",
        effectiveMode: "standard",
        codeMode: { timeout: 20_000, allowFetch: false },
      });
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("keeps server mutation scoped to its config path and reports restart failure", async () => {
    const directory = await createTempDir();
    try {
      const configPath = join(directory, "workspace.jsonc");
      await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      }, "workspace.jsonc");
      const initial = await readConfigSnapshot(configPath);
      const onAuditEvent = vi.fn();
      const source = createConfigManagementSource({
        getConfigPath: async () => configPath,
        restart: () => {
          throw new Error("restart unavailable");
        },
        onAuditEvent,
      });

      const mutation = await source.updateServer(
        "mcp:demo",
        { enabled: false },
        initial.digest,
      );
      expect(mutation).toMatchObject({
        accepted: true,
        changed: true,
        restartState: "failed",
        restart: {
          accepted: false,
          message: "Configuration changed, but context restart could not be scheduled",
        },
      });
      expect((await readConfigSnapshot(configPath)).config.mcpServers.demo.enabled).toBe(false);
      expect(onAuditEvent).toHaveBeenCalledWith({
        type: "server.enabled",
        message: "Server availability updated",
        metadata: expect.objectContaining({
          serverId: "mcp:demo",
          enabled: false,
          previousEnabled: true,
          restartState: "failed",
        }),
      });
    } finally {
      await cleanupTempDir(directory);
    }
  });
});
