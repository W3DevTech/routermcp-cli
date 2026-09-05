import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureWorkspaceRunning,
  fingerprintConfigFile,
  getProcessIdentity,
  getDaemonHostPaths,
  isProcessRunning,
  stopWorkspaceDaemon,
  stopDaemonProcess,
  WorkspaceRegistry,
  type WorkspaceRegistrationInput,
} from "../../../src/daemon/index.js";
import {
  createDaemonHostManifest,
  writeDaemonHostManifest,
} from "../../../src/daemon/host-manifest.js";
import { cleanupTempDir, createTempDir, writeConfigFile } from "../../helpers/test-utils.js";

describe("daemon host compatibility and replacement", () => {
  let stateDir: string;
  let previousStateHome: string | undefined;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    stateDir = await createTempDir();
    previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
  });

  afterEach(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await Promise.all(tempDirs.map((directory) => cleanupTempDir(directory)));
    tempDirs = [];
    await cleanupTempDir(stateDir);
  });

  it("replaces a live incompatible host using only its recorded identity", async () => {
    const projectDir = await createTempDir();
    tempDirs.push(projectDir);
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const configDigest = await fingerprintConfigFile(configPath);
    const input: WorkspaceRegistrationInput = {
      directory: projectDir,
      configPath,
      configScope: "project-local",
      configDigest,
    };

    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("fixture process did not provide a PID");
    const childPid = child.pid;
    const identity = await getProcessIdentity(childPid);
    if (!identity) throw new Error("fixture process identity was unavailable");

    try {
      const hostManifest = await createDaemonHostManifest({
        hostId: getDaemonHostPaths().hostId,
        pid: childPid,
        processIdentity: identity,
        cliVersion: "0.0.0",
        state: "ready",
        port: 7858,
        localAuthToken: "legacy-host-token",
      });
      await writeDaemonHostManifest(getDaemonHostPaths().runtimeManifest, hostManifest);

      const status = await ensureWorkspaceRunning(input, {
        entrypoint: resolve(process.cwd(), "src/index.ts"),
        projectPath: projectDir,
        startupTimeoutMs: 10_000,
      });

      expect(status.running).toBe(true);
      expect(status.pid).not.toBe(childPid);
      expect(isProcessRunning(childPid)).toBe(false);

      await stopWorkspaceDaemon(input, { shutdownTimeoutMs: 5_000 });
    } finally {
      if (isProcessRunning(childPid)) child.kill("SIGKILL");
    }
  }, 30_000);

  it("resets stale lease counts only after an incompatible host is dead", async () => {
    const projectDir = await createTempDir();
    tempDirs.push(projectDir);
    const configPath = await writeConfigFile(projectDir, {
      mcpServers: { test: { transport: "stdio", command: "true" } },
    });
    const registry = new WorkspaceRegistry({
      path: getDaemonHostPaths().workspaceRegistry,
    });
    const configDigest = await fingerprintConfigFile(configPath);
    const input: WorkspaceRegistrationInput = {
      directory: projectDir,
      configPath,
      configScope: "project-local",
      configDigest,
    };
    const registered = await registry.acquire(input);
    expect(registered.activeConnections).toBe(1);

    const hostManifest = await createDaemonHostManifest({
      hostId: getDaemonHostPaths().hostId,
      pid: process.pid + 100_000,
      processIdentity: { pid: process.pid + 100_000, source: "pid" },
      cliVersion: "0.0.0",
      state: "ready",
      port: 7858,
      localAuthToken: "legacy-host-token",
    });
    await writeDaemonHostManifest(getDaemonHostPaths().runtimeManifest, hostManifest);

    const status = await ensureWorkspaceRunning(input, {
      registry,
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      projectPath: projectDir,
      startupTimeoutMs: 10_000,
    });

    expect(status.running).toBe(true);
    expect((await registry.get(registered.id))?.activeConnections).toBe(0);
    await stopWorkspaceDaemon(input, { registry, shutdownTimeoutMs: 5_000 });
  }, 30_000);

  it("does not signal a PID-only identity that could have been reused", async () => {
    const stopped = await stopDaemonProcess({ pid: process.pid, source: "pid" });
    expect(stopped).toBe(false);
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("elects one host for concurrent starts from two projects", async () => {
    const projectA = await createTempDir();
    const projectB = await createTempDir();
    tempDirs.push(projectA, projectB);
    const configA = await writeConfigFile(projectA, {
      mcpServers: { a: { transport: "stdio", command: "true" } },
    });
    const configB = await writeConfigFile(projectB, {
      mcpServers: { b: { transport: "stdio", command: "true" } },
    });
    const configDigestA = await fingerprintConfigFile(configA);
    const configDigestB = await fingerprintConfigFile(configB);
    const inputA: WorkspaceRegistrationInput = {
      directory: projectA,
      configPath: configA,
      configScope: "project-local",
      configDigest: configDigestA,
    };
    const inputB: WorkspaceRegistrationInput = {
      directory: projectB,
      configPath: configB,
      configScope: "project-local",
      configDigest: configDigestB,
    };
    const options = {
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      startupTimeoutMs: 10_000,
    };

    const [statusA, statusB] = await Promise.all([
      ensureWorkspaceRunning(inputA, options),
      ensureWorkspaceRunning(inputB, options),
    ]);

    expect(statusA.running).toBe(true);
    expect(statusB.running).toBe(true);
    expect(statusA.pid).toBe(statusB.pid);
    expect(statusA.port).toBe(statusB.port);
    expect(statusA.workspaceId).not.toBe(statusB.workspaceId);

    await stopWorkspaceDaemon(inputA, { shutdownTimeoutMs: 5_000 });
  }, 30_000);
});
