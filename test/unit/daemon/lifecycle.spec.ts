import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_PORT,
  getDaemonStatus,
  ensureRunning,
  isLoopbackHost,
  stopDaemon,
} from "../../../src/daemon/lifecycle.js";
import { getDaemonPaths } from "../../../src/daemon/paths.js";
import { getProjectId } from "../../../src/daemon/project.js";
import { createRuntimeManifest, writeRuntimeManifest } from "../../../src/daemon/runtime-manifest.js";
import { cleanupTempDir, createTempDir, writeConfigFile } from "../../helpers/test-utils.js";

describe("daemon lifecycle", () => {
  let tempDir: string;
  let projectDir: string;
  let previousStateHome: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    projectDir = await createTempDir();
    previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tempDir;
  });

  afterEach(async () => {
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
    await cleanupTempDir(projectDir);
    await cleanupTempDir(tempDir);
  });

  it("recognizes URL-bracketed IPv6 loopback hostnames", () => {
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::2]")).toBe(false);
  });

  it("starts one persistent daemon when concurrent callers race", async () => {
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const entrypoint = resolve(process.cwd(), "src/index.ts");

    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureRunning(paths, {
          entrypoint,
          projectPath: projectDir,
          startupTimeoutMs: 10_000,
        }),
      ),
    );

    try {
      expect(statuses.every((status) => status.running)).toBe(true);
      expect(new Set(statuses.map((status) => status.pid)).size).toBe(1);
      expect(new Set(statuses.map((status) => status.instanceId)).size).toBe(1);
      expect(statuses[0]?.port).toBeTypeOf("number");
      expect(statuses[0]?.port).toBeGreaterThan(0);

      const reused = await ensureRunning(paths, {
        entrypoint,
        projectPath: projectDir,
      });
      expect(reused.running).toBe(true);
      expect(reused.pid).toBe(statuses[0]?.pid);
      expect(reused.instanceId).toBe(statuses[0]?.instanceId);
    } finally {
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
    }

    expect((await getDaemonStatus(paths)).running).toBe(false);
  }, 30_000);

  it("uses a fallback port when the preferred port is occupied", async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once("error", rejectListen);
      blocker.listen(DEFAULT_DAEMON_PORT, "127.0.0.1", () => resolveListen());
    });

    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const entrypoint = resolve(process.cwd(), "src/index.ts");

    try {
      const status = await ensureRunning(paths, {
        entrypoint,
        projectPath: projectDir,
        startupTimeoutMs: 10_000,
      });
      expect(status.running).toBe(true);
      expect(status.port).toBeGreaterThan(DEFAULT_DAEMON_PORT);
    } finally {
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  }, 30_000);

  it("rejects a ready manifest without a readiness timestamp", async () => {
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const manifest = await createRuntimeManifest({
      projectId: getProjectId(projectDir),
      profileId: paths.profileId,
      configPath,
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      state: "ready",
    });

    delete manifest.readyAt;
    await writeRuntimeManifest(paths.runtimeManifest, manifest);

    const status = await getDaemonStatus(paths);
    expect(status.running).toBe(false);
    expect(status.reason).toContain("readyAt");
  });

  it("rejects incompatible CLI and protocol versions before probing health", async () => {
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const manifest = await createRuntimeManifest({
      projectId: getProjectId(projectDir),
      profileId: paths.profileId,
      configPath,
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      state: "ready",
      port: 7858,
      localAuthToken: "unused",
    });

    await writeRuntimeManifest(paths.runtimeManifest, {
      ...manifest,
      cliVersion: "0.0.0",
    });

    const status = await getDaemonStatus(paths);
    expect(status.running).toBe(false);
    expect(status.reason).toContain("CLI version mismatch");
  });

  it("rejects manifest endpoints that do not match the bound loopback address", async () => {
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const manifest = await createRuntimeManifest({
      projectId: getProjectId(projectDir),
      profileId: paths.profileId,
      configPath,
      configFingerprint: "a".repeat(64),
      pid: process.pid,
      processIdentity: { pid: process.pid, source: "pid" },
      state: "ready",
      host: "127.0.0.1",
      port: 7858,
      localAuthToken: "unused",
      mcpUrl: "http://127.0.0.1:9999/mcp",
    });

    await writeRuntimeManifest(paths.runtimeManifest, manifest);

    const status = await getDaemonStatus(paths);
    expect(status.running).toBe(false);
    expect(status.reason).toContain("invalid MCP or control endpoints");
  });

  it("does not start a second daemon when legacy pid state is still alive", async () => {
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.pid, String(process.pid));
    await writeFile(paths.port, "7858");

    const status = await getDaemonStatus(paths);
    expect(status.running).toBe(false);
    expect(status.pid).toBe(process.pid);
    expect(status.reason).toContain("legacy RouterMCP daemon");

    await expect(
      ensureRunning(paths, {
        entrypoint: resolve(process.cwd(), "src/index.ts"),
        projectPath: projectDir,
        lockTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("legacy RouterMCP daemon");
  });
});
