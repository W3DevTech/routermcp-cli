import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceMcpCredentialStore } from "../../../src/control-plane/index.js";
import { cleanupTempDir, createTempDir } from "../../helpers/test-utils.js";

describe("WorkspaceMcpCredentialStore", () => {
  it("persists only digests and authorizes the same token after reload", async () => {
    const directory = await createTempDir();
    const path = join(directory, "workspace-mcp-credentials.json");
    try {
      const first = new WorkspaceMcpCredentialStore({
        path,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        generateToken: () => "first-workspace-token",
      });
      const issued = await first.issue("workspace-current");

      expect(issued).toMatchObject({
        token: "first-workspace-token",
        scope: "mcp",
        workspaceId: "workspace-current",
        created: true,
        rotated: false,
      });
      expect(first.authorize(issued.token, "workspace-current")).toBe(true);

      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain("first-workspace-token");
      expect(persisted).toContain("workspace-current");

      const reloaded = new WorkspaceMcpCredentialStore({ path });
      await reloaded.initialize();
      expect(reloaded.authorize(issued.token, "workspace-current")).toBe(true);
      expect(reloaded.authorize(issued.token, "workspace-other")).toBe(false);
      expect(await reloaded.issue("workspace-current")).toMatchObject({
        created: false,
        rotated: false,
      });
      expect((await reloaded.issue("workspace-current")).token).toBeUndefined();
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("rotates and revokes a workspace credential", async () => {
    const directory = await createTempDir();
    const path = join(directory, "workspace-mcp-credentials.json");
    let sequence = 0;
    try {
      const store = new WorkspaceMcpCredentialStore({
        path,
        now: () => Date.parse("2026-01-01T00:00:00.000Z") + sequence,
        generateToken: () => `workspace-token-${++sequence}`,
      });
      const first = await store.issue("workspace-current");
      const second = await store.issue("workspace-current", { rotate: true });

      expect(first.token).not.toBe(second.token);
      expect(store.authorize(first.token, "workspace-current")).toBe(false);
      expect(store.authorize(second.token, "workspace-current")).toBe(true);
      expect(await store.revoke("workspace-current")).toBe(true);
      expect(store.authorize(second.token, "workspace-current")).toBe(false);
      expect(await store.revoke("workspace-current")).toBe(false);
    } finally {
      await cleanupTempDir(directory);
    }
  });
});
