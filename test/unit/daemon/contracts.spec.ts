import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fingerprintConfig,
  fingerprintConfigFile,
  fingerprintString,
} from "../../../src/daemon/fingerprint.js";
import { getDaemonPaths } from "../../../src/daemon/paths.js";
import { getProfileDir, getProfileId } from "../../../src/daemon/project.js";
import {
  canTransitionReadiness,
  createReadinessSnapshot,
  transitionReadiness,
} from "../../../src/daemon/readiness.js";
import {
  getProcessIdentity,
  isProcessRunning,
  matchesProcessIdentity,
} from "../../../src/daemon/identity.js";
import { cleanupTempDir, createTempDir } from "../../helpers/test-utils.js";

describe("daemon contracts", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("derives independent profile directories from config paths", () => {
    const projectId = "home-user-project";
    const firstPath = join(tempDir, "one.jsonc");
    const secondPath = join(tempDir, "two.jsonc");

    expect(getProfileId(projectId, firstPath)).not.toBe(getProfileId(projectId, secondPath));
    expect(getProfileDir(projectId, firstPath)).toContain("profiles");

    const paths = getDaemonPaths(projectId, firstPath);
    expect(paths.profileId).toBe(getProfileId(projectId, firstPath));
    expect(paths.runtimeManifest).toBe(join(paths.dir, "runtime.json"));
    expect(paths.lock).toBe(join(paths.dir, "daemon.lock"));
  });

  it("fingerprints configs deterministically and detects source changes", async () => {
    expect(fingerprintConfig({ b: 2, a: 1 })).toBe(fingerprintConfig({ a: 1, b: 2 }));
    expect(fingerprintConfig({ values: [1, 2] })).not.toBe(fingerprintConfig({ values: [2, 1] }));
    expect(fingerprintString("router")).toHaveLength(64);

    const path = join(tempDir, "routermcp.jsonc");
    await writeFile(path, '{"mcpServers":{}}\n');
    const first = await fingerprintConfigFile(path);
    await writeFile(path, '{\n  "mcpServers": {}\n}\n');
    expect(await fingerprintConfigFile(path)).not.toBe(first);
  });

  it("enforces readiness transitions and timestamps", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const starting = createReadinessSnapshot("starting", start);
    const ready = transitionReadiness(starting, "ready", {
      now: new Date("2026-01-01T00:00:01.000Z"),
    });

    expect(ready.state).toBe("ready");
    expect(ready.startedAt).toBe(start.toISOString());
    expect(ready.readyAt).toBe("2026-01-01T00:00:01.000Z");
    expect(canTransitionReadiness("ready", "stopping")).toBe(true);
    expect(() => transitionReadiness(ready, "starting")).toThrow(
      "Invalid daemon readiness transition",
    );
  });

  it("captures and validates process identity", async () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    expect(isProcessRunning(-1)).toBe(false);

    const identity = await getProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    expect(await matchesProcessIdentity(identity as NonNullable<typeof identity>)).toBe(true);

    const wrongIdentity = {
      ...(identity as NonNullable<typeof identity>),
      startToken: `${identity?.startToken ?? "missing"}-wrong`,
    };
    expect(await matchesProcessIdentity(wrongIdentity)).toBe(false);
    expect(await getProcessIdentity(999_999_999)).toBeNull();
  });
});
