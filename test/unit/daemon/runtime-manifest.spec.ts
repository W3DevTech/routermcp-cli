import { chmod, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRuntimeManifest,
  isRuntimeManifest,
  readRuntimeManifest,
  redactRuntimeManifest,
  serializeRuntimeManifest,
  writeRuntimeManifest,
} from "../../../src/daemon/runtime-manifest.js";
import { cleanupTempDir, createTempDir } from "../../helpers/test-utils.js";

describe("runtime manifest", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("writes a complete manifest atomically with private permissions", async () => {
    const path = join(tempDir, "runtime.json");
    const manifest = await createRuntimeManifest({
      projectId: "project",
      profileId: "profile",
      configPath: "/tmp/routermcp.jsonc",
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      port: 7858,
      localAuthToken: "secret-token",
    });

    await writeRuntimeManifest(path, manifest);

    const loaded = await readRuntimeManifest(path);
    expect(loaded).toEqual(manifest);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(tempDir)).toEqual(["runtime.json"]);
  });

  it("replaces an existing manifest without exposing partial JSON", async () => {
    const path = join(tempDir, "runtime.json");
    const first = await createRuntimeManifest({
      projectId: "project",
      profileId: "profile",
      configPath: "/tmp/routermcp.jsonc",
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      instanceId: "first-instance",
    });
    const second = { ...first, instanceId: "second-instance", updatedAt: new Date().toISOString() };

    await writeRuntimeManifest(path, first);
    await writeRuntimeManifest(path, second);

    expect((await readRuntimeManifest(path))?.instanceId).toBe("second-instance");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("returns null for missing, corrupt, and invalid manifests", async () => {
    const path = join(tempDir, "runtime.json");

    expect(await readRuntimeManifest(path)).toBeNull();

    await writeFile(path, "{not-json");
    expect(await readRuntimeManifest(path)).toBeNull();

    await writeFile(path, JSON.stringify({ schemaVersion: 999 }));
    expect(await readRuntimeManifest(path)).toBeNull();
  });

  it("redacts the local authentication token for public consumers", async () => {
    const manifest = await createRuntimeManifest({
      projectId: "project",
      profileId: "profile",
      configPath: "/tmp/routermcp.jsonc",
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      localAuthToken: "secret-token",
    });

    const redacted = redactRuntimeManifest(manifest);
    expect(redacted).not.toHaveProperty("localAuthToken");
    expect(serializeRuntimeManifest(manifest)).toContain("secret-token");
    expect(isRuntimeManifest(manifest)).toBe(true);
  });

  it("does not accept a manifest with an invalid process identity", async () => {
    const path = join(tempDir, "runtime.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        instanceId: "instance",
        projectId: "project",
        profileId: "profile",
        pid: process.pid,
        processIdentity: { pid: process.pid, source: "unknown" },
        cliVersion: "0.2.1",
        protocolVersion: "1",
        configPath: "/tmp/routermcp.jsonc",
        configFingerprint: "a".repeat(64),
        host: "127.0.0.1",
        state: "starting",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    expect(await readRuntimeManifest(path)).toBeNull();
  });

  it("requires the process identity PID to match the manifest PID", async () => {
    const path = join(tempDir, "runtime.json");
    const manifest = await createRuntimeManifest({
      projectId: "project",
      profileId: "profile",
      configPath: "/tmp/routermcp.jsonc",
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
    });

    await writeFile(
      path,
      JSON.stringify({ ...manifest, pid: process.pid + 1 }),
    );
    expect(await readRuntimeManifest(path)).toBeNull();
  });

  it("keeps the manifest private if the destination already has broad mode", async () => {
    const path = join(tempDir, "runtime.json");
    await writeFile(path, "old");
    await chmod(path, 0o644);

    const manifest = await createRuntimeManifest({
      projectId: "project",
      profileId: "profile",
      configPath: "/tmp/routermcp.jsonc",
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
    });
    await writeRuntimeManifest(path, manifest);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
