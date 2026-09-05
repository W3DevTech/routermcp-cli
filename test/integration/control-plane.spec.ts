import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureRunning,
  fingerprintConfigFile,
  getDaemonStatus,
  getDaemonPaths,
  getProjectId,
  ensureWorkspaceRunning,
  stopDaemon,
  WorkspaceRegistry,
} from "../../src/daemon/index.js";
import { MANAGEMENT_CREDENTIAL_HANDOFF_PATH } from "../../src/control-plane/index.js";
import {
  cleanupTempDir,
  createTempDir,
  getAvailablePort,
  writeConfigFile,
} from "../helpers/test-utils.js";

describe("managed daemon control plane", () => {
  let stateDir: string;
  let projectDir: string;
  let configPath: string;
  let previousStateHome: string | undefined;

  beforeEach(async () => {
    stateDir = await createTempDir();
    projectDir = await createTempDir();
    configPath = await writeConfigFile(projectDir, {
      mcpServers: {
        test: { transport: "stdio", command: "true" },
      },
    });
    previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
  });

  afterEach(async () => {
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
    await cleanupTempDir(projectDir);
    await cleanupTempDir(stateDir);
  });

  it("serves authenticated status and management snapshots on the daemon endpoint", async () => {
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const status = await ensureRunning(paths, {
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      projectPath: projectDir,
      preferredPort: await getAvailablePort(),
      startupTimeoutMs: 10_000,
    });

    try {
      expect(status.running).toBe(true);
      expect(status.controlUrl).toBeTypeOf("string");
      expect(status.authToken).toBeTypeOf("string");

      const controlUrl = status.controlUrl as string;
      const authToken = status.authToken as string;
      const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${authToken}`);
        return fetch(new URL(path, `${controlUrl}/`), { ...init, headers });
      };

      const handoffResponse = await fetch(
        new URL(MANAGEMENT_CREDENTIAL_HANDOFF_PATH, `${controlUrl}/`),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
        },
      );
      expect(handoffResponse.status).toBe(201);
      const handoffPayload = (await handoffResponse.json()) as {
        token?: string;
        expiresAt?: string;
        scope?: string;
      };
      expect(handoffPayload).toMatchObject({
        token: expect.any(String),
        expiresAt: expect.any(String),
        scope: "management",
      });
      expect(JSON.stringify(handoffPayload)).not.toContain(authToken);
      expect(handoffPayload).not.toHaveProperty("localAuthToken");

      const managementRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${handoffPayload.token}`);
        return fetch(new URL(path, `${controlUrl}/`), { ...init, headers });
      };

      const managementStatus = await managementRequest("/api/v1/status");
      expect(managementStatus.status).toBe(200);
      expect((await managementStatus.json()).status).toMatchObject({ profile: paths.profileId });

      const managementHealth = await managementRequest("/api/v1/health");
      expect(managementHealth.status).toBe(401);

      const managementMcp = await managementRequest("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(managementMcp.status).toBe(401);

      const managementHandoff = await managementRequest(MANAGEMENT_CREDENTIAL_HANDOFF_PATH, {
        method: "POST",
      });
      expect(managementHandoff.status).toBe(401);

      const unauthenticated = await fetch(new URL("/api/v1/status", `${controlUrl}/`));
      expect(unauthenticated.status).toBe(401);

      const statusResponse = await request("/api/v1/status");
      expect(statusResponse.status).toBe(200);
      const statusPayload = (await statusResponse.json()) as {
        status: Record<string, unknown>;
      };
      expect(statusPayload.status).toMatchObject({
        state: "degraded",
        instanceId: status.instanceId,
        pid: status.pid,
        profile: paths.profileId,
        configDigest: status.configFingerprint,
        port: status.port,
        mcpUrl: status.mcpUrl,
        controlUrl: status.controlUrl,
      });

      const mcpSessionId = "integration-session";
      const initializeResponse = await request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": mcpSessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "control-plane-test", version: "1.0.0" },
          },
        }),
      });
      expect(initializeResponse.status).toBe(200);

      const listToolsResponse = await request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": mcpSessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(listToolsResponse.status).toBe(200);

      const serversResponse = await request("/api/v1/servers");
      expect(serversResponse.status).toBe(200);
      expect((await serversResponse.json()).servers).toEqual([
        expect.objectContaining({
          id: "mcp:test",
          name: "test",
          state: "offline",
          transport: "stdio",
          toolCount: 0,
        }),
      ]);

      const sessionsResponse = await request("/api/v1/sessions");
      expect(sessionsResponse.status).toBe(200);
      const sessionPayload = await sessionsResponse.json();
      expect(sessionPayload.sessions).toEqual([
        expect.objectContaining({
          id: `mcp:${mcpSessionId}`,
          kind: "mcp",
          clientName: "control-plane-test",
          clientVersion: "1.0.0",
          state: "active",
        }),
      ]);

      const metricsResponse = await request("/api/v1/metrics");
      expect(metricsResponse.status).toBe(200);
      expect((await metricsResponse.json()).metrics).toMatchObject({
        requestsTotal: 2,
        errorsTotal: 0,
        toolCallsTotal: 0,
        activeSessions: 1,
        activeLeases: 0,
      });

      const eventsResponse = await request("/api/v1/events?limit=2");
      expect(eventsResponse.status).toBe(200);
      expect((await eventsResponse.json()).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "mcp.request", level: "debug" }),
        ]),
      );

      const startupEventsResponse = await request("/api/v1/events?limit=40");
      expect((await startupEventsResponse.json()).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "daemon.ready", level: "info" })]),
      );

      const preflight = await fetch(new URL("/api/v1/status", `${controlUrl}/`), {
        method: "OPTIONS",
        headers: {
          Origin: "https://cli.routermcp.com",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
          "Access-Control-Request-Private-Network": "true",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://cli.routermcp.com",
      );
      expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    } finally {
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
    }
  }, 30_000);

  it("acknowledges restart before replacing the managed daemon instance", async () => {
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const status = await ensureRunning(paths, {
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      projectPath: projectDir,
      preferredPort: await getAvailablePort(),
      startupTimeoutMs: 10_000,
    });

    try {
      const response = await fetch(new URL("/api/v1/restart", `${status.controlUrl}/`), {
        method: "POST",
        headers: { Authorization: `Bearer ${status.authToken}` },
      });
      expect(response.status).toBe(202);

      const configFingerprint = await fingerprintConfigFile(configPath);
      const deadline = Date.now() + 15_000;
      let replacement = await getDaemonStatus(paths, { configFingerprint });
      while (Date.now() < deadline) {
        if (replacement.running && replacement.instanceId !== status.instanceId) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        replacement = await getDaemonStatus(paths, { configFingerprint });
      }

      expect(replacement.running).toBe(true);
      expect(replacement.instanceId).not.toBe(status.instanceId);
      expect(replacement.pid).not.toBe(status.pid);
      // Existing stdio bridges keep using the daemon credential while the
      // managed process is replaced, then reacquire a fresh lease.
      expect(replacement.authToken).toBe(status.authToken);
    } finally {
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
    }
  }, 40_000);

  it("keeps an active stdio bridge connected across a managed restart", async () => {
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const status = await ensureRunning(paths, {
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      projectPath: projectDir,
      preferredPort: await getAvailablePort(),
      startupTimeoutMs: 10_000,
    });
    const runtime = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
      ? process.execPath
      : "bun";
    const child = spawn(
      runtime,
      [
        resolve(process.cwd(), "src/index.ts"),
        "connect",
        "--config",
        configPath,
        "--project",
        projectDir,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ROUTERMCP_TELEMETRY: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const waitForOutput = async (needle: string, timeoutMs = 15_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stdout.includes(needle)) return;
        if (child.exitCode !== null) {
          throw new Error(`connect exited with ${child.exitCode}: ${stderr}`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      throw new Error(`Timed out waiting for ${needle}: ${stdout}\n${stderr}`);
    };

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "restart-bridge-test", version: "1.0.0" },
          },
        })}\n`,
      );
      await waitForOutput('"id":1');
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const restartResponse = await fetch(new URL("/api/v1/restart", `${status.controlUrl}/`), {
        method: "POST",
        headers: { Authorization: `Bearer ${status.authToken}` },
      });
      expect(restartResponse.status).toBe(202);

      const configFingerprint = await fingerprintConfigFile(configPath);
      const deadline = Date.now() + 15_000;
      let replacement = await getDaemonStatus(paths, { configFingerprint });
      while (Date.now() < deadline) {
        if (replacement.running && replacement.instanceId !== status.instanceId) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        replacement = await getDaemonStatus(paths, { configFingerprint });
      }
      expect(replacement.running).toBe(true);
      expect(replacement.instanceId).not.toBe(status.instanceId);
      expect(replacement.authToken).toBe(status.authToken);

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
      await waitForOutput('"id":2');
      expect(child.exitCode).toBeNull();
    } finally {
      child.stdin.end();
      await new Promise<void>((resolveClose) => {
        if (child.exitCode !== null) {
          resolveClose();
          return;
        }
        const timer = setTimeout(resolveClose, 5_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolveClose();
        });
      });
      if (child.exitCode === null) child.kill("SIGTERM");
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
    }
  }, 50_000);

  it("clears stale workspace lease counts after the host process dies", async () => {
    const paths = getDaemonPaths(getProjectId(projectDir), configPath, projectDir);
    const configDigest = await fingerprintConfigFile(configPath);
    const workspace = {
      directory: projectDir,
      configPath,
      configScope: "project-local" as const,
      configDigest,
    };
    const registry = new WorkspaceRegistry();
    const started = await ensureWorkspaceRunning(workspace, {
      registry,
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      projectPath: projectDir,
      preferredPort: await getAvailablePort(),
      startupTimeoutMs: 10_000,
    });
    await registry.acquire(workspace);

    try {
      expect(started.pid).toBeTypeOf("number");
      expect((await registry.list())[0]?.activeConnections).toBe(1);
      process.kill(started.pid as number, "SIGKILL");

      const deadDeadline = Date.now() + 5_000;
      let deadStatus = await getDaemonStatus(paths, { configFingerprint: configDigest });
      while (Date.now() < deadDeadline && deadStatus.running) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        deadStatus = await getDaemonStatus(paths, { configFingerprint: configDigest });
      }
      expect(deadStatus.running).toBe(false);

      const replacement = await ensureWorkspaceRunning(workspace, {
        registry,
        entrypoint: resolve(process.cwd(), "src/index.ts"),
        projectPath: projectDir,
        preferredPort: started.port,
        startupTimeoutMs: 10_000,
      });
      expect(replacement.running).toBe(true);
      expect(replacement.pid).not.toBe(started.pid);
      expect((await registry.list())[0]?.activeConnections).toBe(0);
    } finally {
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
    }
  }, 45_000);

  it("includes OpenAPI adapter snapshots in server health and status", async () => {
    const openApiConfigPath = await writeConfigFile(
      projectDir,
      {
        mcpServers: {},
        openApiServers: {
          catalog: {
            spec: "missing-openapi-spec.json",
            baseUrl: "https://catalog.example.com/api?token=secret",
          },
        },
      },
      "routermcp-openapi.jsonc",
    );
    const paths = getDaemonPaths(getProjectId(projectDir), openApiConfigPath, projectDir);
    const status = await ensureRunning(paths, {
      entrypoint: resolve(process.cwd(), "src/index.ts"),
      projectPath: projectDir,
      preferredPort: await getAvailablePort(),
      startupTimeoutMs: 10_000,
    });

    try {
      expect(status.running).toBe(true);
      const request = (path: string) =>
        fetch(new URL(path, `${status.controlUrl}/`), {
          headers: { Authorization: `Bearer ${status.authToken}` },
        });

      const statusResponse = await request("/api/v1/status");
      expect((await statusResponse.json()).status.state).toBe("degraded");

      const serversResponse = await request("/api/v1/servers");
      expect((await serversResponse.json()).servers).toEqual([
        expect.objectContaining({
          id: "openapi:catalog",
          name: "catalog",
          transport: "openapi",
          state: "offline",
          toolCount: 0,
          url: "https://catalog.example.com/api",
          lastError: expect.stringContaining("missing-openapi-spec.json"),
        }),
      ]);
    } finally {
      await stopDaemon(paths, { shutdownTimeoutMs: 5_000 });
    }
  }, 30_000);
});
