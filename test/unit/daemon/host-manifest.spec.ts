import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDaemonHostManifest,
  DAEMON_HOST_CAPABILITIES,
  DAEMON_HOST_CAPABILITY_VERSION,
  getDaemonHostCompatibility,
  isDaemonHostManifest,
  readDaemonHostManifest,
  redactDaemonHostManifest,
  serializeDaemonHostManifest,
  writeDaemonHostManifest,
} from "../../../src/daemon/host-manifest.js";
import { cleanupTempDir, createTempDir } from "../../helpers/test-utils.js";

describe("daemon host manifest", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("writes a complete host manifest atomically with private permissions", async () => {
    const path = join(tempDir, "host", "runtime.json");
    const manifest = await createDaemonHostManifest({
      hostId: "host-1",
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      port: 7858,
      primaryProjectPath: "/workspace/app",
      primaryConfigPath: "/workspace/app/routermcp.jsonc",
      primaryProfileId: "profile-1",
      primaryConfigFingerprint: "a".repeat(64),
      localAuthToken: "local-secret",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    await writeDaemonHostManifest(path, manifest);

    expect(await readDaemonHostManifest(path)).toEqual(manifest);
    expect(manifest.hostProtocolVersion).toBe("1");
    expect(manifest.hostCapabilityVersion).toBe(DAEMON_HOST_CAPABILITY_VERSION);
    expect(manifest.hostCapabilities).toEqual(DAEMON_HOST_CAPABILITIES);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(tempDir, "host"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(tempDir, "host"))).toEqual(["runtime.json"]);
  });

  it("redacts local auth material and rejects incompatible state", async () => {
    const manifest = await createDaemonHostManifest({
      hostId: "host-1",
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      localAuthToken: "local-secret",
    });

    const redacted = redactDaemonHostManifest(manifest);
    expect(redacted).not.toHaveProperty("localAuthToken");
    expect(serializeDaemonHostManifest(manifest)).toContain("local-secret");
    expect(isDaemonHostManifest(manifest)).toBe(true);

    const path = join(tempDir, "runtime.json");
    await writeFile(path, JSON.stringify({ ...manifest, schemaVersion: 999 }));
    expect(await readDaemonHostManifest(path)).toBeNull();
    expect(() => serializeDaemonHostManifest({ ...manifest, hostId: "" })).toThrow(
      "invalid RouterMCP daemon host manifest",
    );
  });

  it("requires process identity and manifest pid to agree", async () => {
    const manifest = await createDaemonHostManifest({
      hostId: "host-1",
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
    });

    expect(
      isDaemonHostManifest({
        ...manifest,
        pid: process.pid + 1,
      }),
    ).toBe(false);
  });

  it("keeps old host manifests readable but marks them incompatible", async () => {
    const manifest = await createDaemonHostManifest({
      hostId: "host-1",
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
    });
    const legacy = { ...manifest };
    delete legacy.hostProtocolVersion;
    delete legacy.hostCapabilityVersion;
    delete legacy.hostCapabilities;

    expect(isDaemonHostManifest(legacy)).toBe(true);
    expect(getDaemonHostCompatibility(legacy)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining("host protocol mismatch"),
    });
  });

  it("rejects a host missing one required capability", async () => {
    const manifest = await createDaemonHostManifest({
      hostId: "host-1",
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      hostCapabilities: ["workspace-routing"],
    });

    expect(getDaemonHostCompatibility(manifest)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining("required capabilities"),
    });
  });
});
