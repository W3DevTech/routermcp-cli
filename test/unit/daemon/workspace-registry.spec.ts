import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceDescriptor,
  getWorkspaceId,
  WorkspaceLeaseTracker,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  type WorkspaceRegistrationInput,
} from "../../../src/daemon/workspace-registry.js";
import { cleanupTempDir, createTempDir, writeConfigFile } from "../../helpers/test-utils.js";

describe("WorkspaceRegistry", () => {
  let tempDir: string;
  let directory: string;
  let configPath: string;
  let registration: WorkspaceRegistrationInput;

  beforeEach(async () => {
    tempDir = await createTempDir();
    directory = await createTempDir();
    configPath = await writeConfigFile(directory, { mcpServers: {} });
    registration = {
      directory,
      configPath,
      configScope: "project-local",
      configDigest: "a".repeat(64),
    };
  });

  afterEach(async () => {
    await cleanupTempDir(directory);
    await cleanupTempDir(tempDir);
  });

  it("canonicalizes paths and verifies optional identity claims", async () => {
    const descriptor = await createWorkspaceDescriptor(registration);
    expect(descriptor.directory).toBe(directory);
    expect(descriptor.configPath).toBe(configPath);
    expect(descriptor.id).toBe(getWorkspaceId(directory, configPath));

    await expect(
      createWorkspaceDescriptor({ ...registration, workspaceId: "wrong" }),
    ).rejects.toThrow("canonical paths");
    await expect(
      createWorkspaceDescriptor({ ...registration, profileId: "wrong" }),
    ).rejects.toThrow("canonical paths");
  });

  it("persists active/known records atomically and reloads them", async () => {
    const path = join(tempDir, "workspaces.json");
    const first = new WorkspaceRegistry({ path });
    const active = await first.acquire(registration);
    expect(active.state).toBe("active");
    expect(active.activeConnections).toBe(1);

    const second = new WorkspaceRegistry({ path });
    await second.load();
    expect(await second.get(active.id)).toMatchObject({
      id: active.id,
      directory,
      configPath,
      state: "active",
      activeConnections: 1,
    });

    const known = await second.release(active.id);
    expect(known).toMatchObject({ state: "known", activeConnections: 0 });
    const document = JSON.parse(await readFile(path, "utf8")) as {
      workspaces: Array<{ activeConnections: number }>;
    };
    expect(document.workspaces[0]?.activeConnections).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("retains active records while bounding inactive records", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const path = join(tempDir, "workspaces.json");
    const registry = new WorkspaceRegistry({
      path,
      maxRecords: 1,
      retentionMs: 1_000,
      now: () => now,
    });
    const first = await registry.acquire(registration);
    const secondDirectory = await createTempDir();
    const secondConfig = await writeConfigFile(secondDirectory, { mcpServers: {} });
    try {
      const second = await registry.acquire({
        directory: secondDirectory,
        configPath: secondConfig,
        configScope: "project-local",
        configDigest: "b".repeat(64),
      });
      expect(registry.size).toBe(2);
      expect(registry.getSync(first.id)?.activeConnections).toBe(1);
      expect(registry.getSync(second.id)?.activeConnections).toBe(1);

      await registry.release(first.id);
      await registry.release(second.id);
      now += 2_000;
      expect(await registry.list()).toHaveLength(0);
    } finally {
      await cleanupTempDir(secondDirectory);
    }
  });

  it("sanitizes unavailable errors and refuses to forget active records", async () => {
    const registry = new WorkspaceRegistry({ path: join(tempDir, "workspaces.json") });
    const active = await registry.acquire(registration);
    await expect(registry.forget(active.id)).rejects.toThrow(WorkspaceRegistryError);

    await registry.release(active.id);
    const unavailable = await registry.markUnavailable(
      active.id,
      new Error("Bearer super-secret https://user:password@example.com/?token=secret\n"),
    );
    expect(unavailable?.state).toBe("unavailable");
    expect(unavailable?.lastError).toBe(
      "Bearer [redacted] https://user:password@example.com/?token=[redacted] ",
    );
    await expect(registry.forget(active.id)).resolves.toBe(true);
    expect(registry.size).toBe(0);
  });

  it("attributes bridge lease acquire, heartbeat, and release to a workspace", async () => {
    const registry = new WorkspaceRegistry({ path: join(tempDir, "workspaces.json") });
    const tracker = new WorkspaceLeaseTracker(registry, { leaseTtlMs: 1_000 });

    const lease = await tracker.acquire(registration);
    expect(lease.workspaceId).toBe(getWorkspaceId(directory, configPath));
    expect((await registry.get(lease.workspaceId ?? ""))?.activeConnections).toBe(1);

    const beforeHeartbeat = (await registry.get(lease.workspaceId ?? ""))?.lastSeenAt;
    await tracker.heartbeat(lease.leaseId);
    const afterHeartbeat = (await registry.get(lease.workspaceId ?? ""))?.lastSeenAt;
    expect(afterHeartbeat).toBeTypeOf("string");
    expect(Date.parse(afterHeartbeat ?? "")).toBeGreaterThanOrEqual(
      Date.parse(beforeHeartbeat ?? ""),
    );

    await tracker.release(lease.leaseId);
    expect((await registry.get(lease.workspaceId ?? ""))?.activeConnections).toBe(0);

    const destroyedLease = await tracker.acquire(registration);
    expect((await registry.get(destroyedLease.workspaceId ?? ""))?.activeConnections).toBe(1);
    await tracker.destroy();
    expect((await registry.get(destroyedLease.workspaceId ?? ""))?.activeConnections).toBe(0);
  });
});
