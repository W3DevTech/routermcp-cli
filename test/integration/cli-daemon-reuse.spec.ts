import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceId, isProcessRunning } from "../../src/daemon/index.js";
import {
  cleanupTempDir,
  createTempDir,
  getAvailablePort,
  writeConfigFile,
} from "../helpers/test-utils.js";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("CLI daemon reuse", () => {
  let stateDir: string;
  let projectDir: string;
  let configPath: string;
  const entrypoint = resolve(process.cwd(), "src/index.ts");

  beforeEach(async () => {
    stateDir = await createTempDir();
    projectDir = await createTempDir();
    configPath = await writeConfigFile(projectDir, {
      mcpServers: {
        test: { transport: "stdio", command: "true" },
      },
    });
  });

  afterEach(async () => {
    await cleanupTempDir(projectDir);
    await cleanupTempDir(stateDir);
  });

  it("starts once, reuses the PID for bare/connect, and stops cleanly", async () => {
    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      // Avoid writing a user telemetry config while the child CLI is tested.
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = [
      "--config",
      configPath,
      "--project",
      projectDir,
      "--host",
      "127.0.0.2",
      "--port",
      String(preferredPort),
      "--json",
    ];

    const started = await runCli(entrypoint, ["start", ...common], env);
    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    const startedStatus = JSON.parse(started.stdout) as {
      pid?: number;
      instanceId?: string;
      state?: string;
    };
    expect(startedStatus.pid).toBeTypeOf("number");
    expect(startedStatus.instanceId).toBeTypeOf("string");

    const status = await runCli(entrypoint, ["status", ...common], env);
    expect(status.code).toBe(0);
    const hostManifest = JSON.parse(
      await readFile(resolve(stateDir, "routermcp", "host", "runtime.json"), "utf8"),
    ) as { localAuthToken: string };
    expect(hostManifest.localAuthToken).toBeTypeOf("string");
    expect(status.stdout).not.toContain(hostManifest.localAuthToken);
    const statusManifest = JSON.parse(status.stdout) as {
      pid?: number;
      instanceId?: string;
      state?: string;
      authToken?: string;
    };
    expect(statusManifest).not.toHaveProperty("authToken");
    expect(statusManifest.pid).toBe(startedStatus.pid);
    expect(statusManifest.instanceId).toBe(startedStatus.instanceId);
    expect(statusManifest.state).toBe("ready");

    const mcpRequest = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
    const connected = await runCli(
      entrypoint,
      ["connect", "--config", configPath, "--project", projectDir],
      env,
      mcpRequest,
    );
    expect(connected.code).toBe(0);
    expect(connected.stderr).toContain(`pid: ${startedStatus.pid}`);
    expect(connected.stderr).toContain("Connected to daemon");
    expect(connected.stderr).toContain("Workspace MCP URL: http://127.0.0.2:");
    expect(connected.stderr).not.toContain("Connected to daemon at ");
    expect(connected.stdout).toContain('"jsonrpc"');

    const bare = await runCli(
      entrypoint,
      ["--config", configPath, "--project", projectDir],
      env,
      mcpRequest,
    );
    expect(bare.code).toBe(0);
    expect(bare.stderr).toContain(`pid: ${startedStatus.pid}`);
    expect(bare.stderr).toContain("Connected to daemon");
    expect(bare.stderr).toContain("Workspace MCP URL: http://127.0.0.2:");
    expect(bare.stderr).not.toContain("Connected to daemon at ");
    expect(bare.stdout).toContain('"jsonrpc"');

    const stopped = await runCli(entrypoint, ["stop", ...common], env);
    expect(stopped.code).toBe(0);
    const stoppedStatus = JSON.parse(stopped.stdout) as { running?: boolean; state?: string };
    expect(stoppedStatus.running).toBe(false);
    expect(stoppedStatus.state).toBe("stopped");

    const finalStatus = await runCli(entrypoint, ["status", ...common], env);
    expect(finalStatus.code).toBe(0);
    const finalManifest = JSON.parse(finalStatus.stdout) as { running?: boolean };
    expect(finalManifest.running).toBe(false);
  }, 45_000);

  it("reuses one host across directories with different config profiles", async () => {
    const secondProjectDir = await createTempDir();
    const secondConfigPath = await writeConfigFile(secondProjectDir, {
      mcpServers: { second: { transport: "stdio", command: "true" } },
    });
    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = ["--host", "127.0.0.1", "--port", String(preferredPort), "--json"];

    try {
      const first = await runCli(
        entrypoint,
        ["start", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const firstStatus = JSON.parse(first.stdout) as { pid?: number; instanceId?: string };

      const second = await runCli(
        entrypoint,
        ["start", "--config", configPath, "--project", secondProjectDir, ...common],
        env,
      );
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
      const secondStatus = JSON.parse(second.stdout) as { pid?: number; instanceId?: string };
      expect(secondStatus.pid).toBe(firstStatus.pid);
      expect(secondStatus.instanceId).toBe(firstStatus.instanceId);

      const connected = await runCli(
        entrypoint,
        ["connect", "--config", configPath, "--project", secondProjectDir],
        env,
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
      );
      expect(connected.code, `${connected.stdout}\n${connected.stderr}`).toBe(0);
      expect(connected.stderr).toContain(`pid: ${firstStatus.pid}`);

      const registryPath = resolve(stateDir, "routermcp", "host", "workspaces.json");
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
        workspaces: Array<{ id: string; directory: string; activeConnections: number }>;
      };
      expect(registry.workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: getWorkspaceId(projectDir, configPath),
            directory: projectDir,
          }),
          expect.objectContaining({
            id: getWorkspaceId(secondProjectDir, configPath),
            directory: secondProjectDir,
          }),
        ]),
      );

      const secondProfile = await runCli(
        entrypoint,
        ["start", "--config", secondConfigPath, "--project", secondProjectDir, ...common],
        env,
      );
      expect(secondProfile.code, `${secondProfile.stdout}\n${secondProfile.stderr}`).toBe(0);
      const secondProfileStatus = JSON.parse(secondProfile.stdout) as {
        pid?: number;
        instanceId?: string;
      };
      expect(secondProfileStatus.pid).toBe(firstStatus.pid);
      expect(secondProfileStatus.instanceId).toBe(firstStatus.instanceId);

      const secondConnected = await runCli(
        entrypoint,
        ["connect", "--config", secondConfigPath, "--project", secondProjectDir],
        env,
        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
      );
      expect(secondConnected.code, `${secondConnected.stdout}\n${secondConnected.stderr}`).toBe(0);
      expect(secondConnected.stderr).toContain(`pid: ${firstStatus.pid}`);
      expect(secondConnected.stdout).toContain('"jsonrpc"');
    } finally {
      const stopped = await runCli(
        entrypoint,
        ["stop", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await cleanupTempDir(secondProjectDir);
    }
  }, 45_000);

  it("replaces a crashed host when the next project connects", async () => {
    const secondProjectDir = await createTempDir();
    const secondConfigPath = await writeConfigFile(secondProjectDir, {
      mcpServers: { second: { transport: "stdio", command: "true" } },
    });
    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = ["--host", "127.0.0.1", "--port", String(preferredPort), "--json"];

    try {
      const first = await runCli(
        entrypoint,
        ["start", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const firstStatus = JSON.parse(first.stdout) as { pid?: number; instanceId?: string };
      expect(firstStatus.pid).toBeTypeOf("number");
      expect(firstStatus.instanceId).toBeTypeOf("string");

      const firstHostManifest = JSON.parse(
        await readFile(resolve(stateDir, "routermcp", "host", "runtime.json"), "utf8"),
      ) as { controlUrl: string; localAuthToken: string };
      const workspaceId = getWorkspaceId(projectDir, configPath);
      const credentialResponse = await fetch(
        new URL("/api/v1/management/mcp-credential", `${firstHostManifest.controlUrl}/`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firstHostManifest.localAuthToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspaceId }),
        },
      );
      expect(credentialResponse.status).toBe(201);
      const workspaceCredential = (await credentialResponse.json()) as { token?: string };
      expect(workspaceCredential.token).toBeTypeOf("string");

      // Simulate an abrupt daemon crash. The host manifest is intentionally
      // left behind so the next workspace exercises stale-host recovery.
      process.kill(firstStatus.pid!, "SIGKILL");
      await waitForProcessExit(firstStatus.pid!);

      const second = await runCli(
        entrypoint,
        ["connect", "--config", secondConfigPath, "--project", secondProjectDir],
        env,
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
      );
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(second.stderr).toContain("Daemon started");
      expect(second.stdout).toContain('"jsonrpc"');

      const replacement = await runCli(
        entrypoint,
        ["status", "--config", secondConfigPath, "--project", secondProjectDir, ...common],
        env,
      );
      expect(replacement.code, `${replacement.stdout}\n${replacement.stderr}`).toBe(0);
      const replacementStatus = JSON.parse(replacement.stdout) as {
        pid?: number;
        instanceId?: string;
        state?: string;
      };
      expect(replacementStatus.pid).not.toBe(firstStatus.pid);
      expect(replacementStatus.instanceId).not.toBe(firstStatus.instanceId);
      expect(replacementStatus.state).toBe("ready");

      const replacementHostManifest = JSON.parse(
        await readFile(resolve(stateDir, "routermcp", "host", "runtime.json"), "utf8"),
      ) as { controlUrl: string };
      const directMcpResponse = await fetch(
        new URL(`/api/v1/workspaces/${workspaceId}/mcp`, `${replacementHostManifest.controlUrl}/`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${workspaceCredential.token}`,
            "Content-Type": "application/json",
          },
          body: '{"jsonrpc":"2.0","id":2,"method":"ping"}',
        },
      );
      expect(directMcpResponse.status).toBe(200);
      expect(await directMcpResponse.json()).toMatchObject({ jsonrpc: "2.0", id: 2 });
    } finally {
      const stopped = await runCli(
        entrypoint,
        ["stop", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await cleanupTempDir(secondProjectDir);
    }
  }, 45_000);

  it("creates, reuses, and rotates a durable workspace MCP config", async () => {
    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = [
      "--config",
      configPath,
      "--project",
      projectDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(preferredPort),
      "--json",
    ];

    try {
      const first = await runCli(entrypoint, ["mcp-config", ...common], env);
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const firstConfig = JSON.parse(first.stdout) as {
        url?: string;
        authorization?: string;
        configuredAt?: string;
        created?: boolean;
        rotated?: boolean;
      };
      expect(firstConfig.url).toContain("/api/v1/workspaces/");
      expect(firstConfig.authorization).toMatch(/^Bearer .+/);
      expect(firstConfig.configuredAt).toBeTypeOf("string");
      expect(firstConfig.created).toBe(true);
      expect(firstConfig.rotated).toBe(false);

      const repeated = await runCli(entrypoint, ["mcp-config", ...common], env);
      expect(repeated.code, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
      const repeatedConfig = JSON.parse(repeated.stdout) as {
        authorization?: string;
        configuredAt?: string;
        created?: boolean;
        rotated?: boolean;
      };
      expect(repeatedConfig).not.toHaveProperty("authorization");
      expect(repeatedConfig.configuredAt).toBe(firstConfig.configuredAt);
      expect(repeatedConfig.created).toBe(false);
      expect(repeatedConfig.rotated).toBe(false);

      const rotated = await runCli(entrypoint, ["mcp-config", "--rotate", ...common], env);
      expect(rotated.code, `${rotated.stdout}\n${rotated.stderr}`).toBe(0);
      const rotatedConfig = JSON.parse(rotated.stdout) as {
        authorization?: string;
        configuredAt?: string;
        rotatedAt?: string;
        created?: boolean;
        rotated?: boolean;
      };
      expect(rotatedConfig.authorization).toMatch(/^Bearer .+/);
      expect(rotatedConfig.authorization).not.toBe(firstConfig.authorization);
      expect(rotatedConfig.configuredAt).toBe(firstConfig.configuredAt);
      expect(rotatedConfig.rotatedAt).toBeTypeOf("string");
      expect(rotatedConfig.created).toBe(false);
      expect(rotatedConfig.rotated).toBe(true);

      const connected = await runCli(
        entrypoint,
        ["connect", "--config", configPath, "--project", projectDir],
        env,
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
      );
      expect(connected.code, `${connected.stdout}\n${connected.stderr}`).toBe(0);
      expect(connected.stderr).not.toContain(firstConfig.authorization);
      expect(connected.stderr).not.toContain(rotatedConfig.authorization);
    } finally {
      const stopped = await runCli(entrypoint, ["stop", ...common], env);
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    }
  }, 45_000);

  it("explicitly activates a registered workspace and reuses its healthy runtime", async () => {
    const secondProjectDir = await createTempDir();
    const secondConfigPath = await writeConfigFile(secondProjectDir, {
      mcpServers: { second: { transport: "stdio", command: "true" } },
    });
    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = ["--host", "127.0.0.1", "--port", String(preferredPort), "--json"];

    try {
      const first = await runCli(
        entrypoint,
        ["start", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);

      const second = await runCli(
        entrypoint,
        ["start", "--config", secondConfigPath, "--project", secondProjectDir, ...common],
        env,
      );
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);

      const hostManifest = JSON.parse(
        await readFile(resolve(stateDir, "routermcp", "host", "runtime.json"), "utf8"),
      ) as { controlUrl: string; localAuthToken: string };
      const handoff = await fetch(
        new URL("/api/v1/management/handoff", `${hostManifest.controlUrl}/`),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${hostManifest.localAuthToken}` },
        },
      );
      expect(handoff.status).toBe(201);
      const grant = (await handoff.json()) as { token: string };
      const headers = { Authorization: `Bearer ${grant.token}` };
      const workspaceId = getWorkspaceId(secondProjectDir, secondConfigPath);

      const before = await fetch(
        new URL(`/api/v1/workspaces/${workspaceId}/status`, `${hostManifest.controlUrl}/`),
        { headers },
      );
      expect(before.status).toBe(200);
      expect((await before.json()).status.state).toBe("offline");

      const activation = await fetch(
        new URL(`/api/v1/workspaces/${workspaceId}/activate`, `${hostManifest.controlUrl}/`),
        { method: "POST", headers },
      );
      expect(activation.status).toBe(202);
      expect(await activation.json()).toMatchObject({
        workspaceId,
        state: "initializing",
      });

      const deadline = Date.now() + 10_000;
      let after = await fetch(
        new URL(`/api/v1/workspaces/${workspaceId}/status`, `${hostManifest.controlUrl}/`),
        { headers },
      );
      let afterPayload = await after.json();
      while (Date.now() < deadline) {
        if (afterPayload.status.state === "ready" || afterPayload.status.state === "degraded")
          break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        after = await fetch(
          new URL(`/api/v1/workspaces/${workspaceId}/status`, `${hostManifest.controlUrl}/`),
          { headers },
        );
        afterPayload = await after.json();
      }
      expect(after.status).toBe(200);
      expect(["ready", "degraded"]).toContain(afterPayload.status.state);
      expect(afterPayload.servers).toEqual([
        expect.objectContaining({ id: "mcp:second", name: "second" }),
      ]);

      const repeated = await fetch(
        new URL(`/api/v1/workspaces/${workspaceId}/activate`, `${hostManifest.controlUrl}/`),
        { method: "POST", headers },
      );
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ workspaceId, state: "ready" });

      const concurrent = await Promise.all(
        Array.from({ length: 3 }, () =>
          fetch(
            new URL(`/api/v1/workspaces/${workspaceId}/activate`, `${hostManifest.controlUrl}/`),
            { method: "POST", headers },
          ),
        ),
      );
      expect(concurrent.map((response) => response.status)).toEqual([200, 200, 200]);
    } finally {
      const stopped = await runCli(
        entrypoint,
        ["stop", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await cleanupTempDir(secondProjectDir);
    }
  }, 45_000);

  it("returns an unavailable workspace snapshot when its config is missing or malformed", async () => {
    const secondProjectDir = await createTempDir();
    const secondConfigPath = await writeConfigFile(secondProjectDir, {
      mcpServers: { second: { transport: "stdio", command: "true" } },
    });
    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = ["--host", "127.0.0.1", "--port", String(preferredPort), "--json"];

    try {
      const first = await runCli(
        entrypoint,
        ["start", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);

      const second = await runCli(
        entrypoint,
        ["start", "--config", secondConfigPath, "--project", secondProjectDir, ...common],
        env,
      );
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);

      const hostManifest = JSON.parse(
        await readFile(resolve(stateDir, "routermcp", "host", "runtime.json"), "utf8"),
      ) as { controlUrl: string; localAuthToken: string };
      const handoff = await fetch(
        new URL("/api/v1/management/handoff", `${hostManifest.controlUrl}/`),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${hostManifest.localAuthToken}` },
        },
      );
      expect(handoff.status).toBe(201);
      const grant = (await handoff.json()) as { token: string };
      const headers = { Authorization: `Bearer ${grant.token}` };
      const workspaceId = getWorkspaceId(secondProjectDir, secondConfigPath);
      const endpoint = new URL(
        `/api/v1/workspaces/${workspaceId}/status`,
        `${hostManifest.controlUrl}/`,
      );

      await unlink(secondConfigPath);
      const missing = await fetch(endpoint, { headers });
      expect(missing.status).toBe(200);
      const missingPayload = (await missing.json()) as {
        workspace: { state: string; lastError?: string };
        status: { state: string };
        servers: unknown[];
      };
      expect(missingPayload.workspace.state).toBe("unavailable");
      expect(missingPayload.workspace.lastError).toEqual(expect.any(String));
      expect(missingPayload.status.state).toBe("offline");
      expect(missingPayload.servers).toEqual([]);

      await writeFile(secondConfigPath, '{"mcpServers":', "utf8");
      const malformed = await fetch(endpoint, { headers });
      expect(malformed.status).toBe(200);
      const malformedPayload = (await malformed.json()) as {
        workspace: { state: string; lastError?: string };
        status: { state: string };
        servers: unknown[];
      };
      expect(malformedPayload.workspace.state).toBe("unavailable");
      expect(malformedPayload.workspace.lastError).toEqual(expect.any(String));
      expect(malformedPayload.status.state).toBe("offline");
      expect(malformedPayload.servers).toEqual([]);
    } finally {
      const stopped = await runCli(
        entrypoint,
        ["stop", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await cleanupTempDir(secondProjectDir);
    }
  }, 45_000);

  it("isolates tools for two workspaces behind one host process", async () => {
    const secondProjectDir = await createTempDir();
    const secondConfigPath = resolve(secondProjectDir, "routermcp.jsonc");
    const everythingEntrypoint = resolve(
      process.cwd(),
      "node_modules/@modelcontextprotocol/server-everything/dist/stdio.js",
    );
    const upstream = {
      transport: "stdio" as const,
      command: process.execPath,
      args: [everythingEntrypoint],
    };
    await writeConfigFile(projectDir, {
      mcpServers: { shared: { ...upstream, allowedTools: ["echo"] } },
    });
    await writeConfigFile(secondProjectDir, {
      mcpServers: { shared: { ...upstream, allowedTools: ["add"] } },
    });

    const env = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
      ROUTERMCP_TELEMETRY: "0",
    };
    const preferredPort = await getAvailablePort();
    const common = ["--host", "127.0.0.1", "--port", String(preferredPort), "--json"];

    try {
      const first = await runCli(
        entrypoint,
        ["start", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const firstStatus = JSON.parse(first.stdout) as { pid?: number; instanceId?: string };

      const second = await runCli(
        entrypoint,
        ["start", "--config", secondConfigPath, "--project", secondProjectDir, ...common],
        env,
      );
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
      const secondStatus = JSON.parse(second.stdout) as { pid?: number; instanceId?: string };
      expect(secondStatus.pid).toBe(firstStatus.pid);
      expect(secondStatus.instanceId).toBe(firstStatus.instanceId);

      const request = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';
      const firstTools = await runCli(
        entrypoint,
        ["connect", "--config", configPath, "--project", projectDir],
        env,
        request,
      );
      const secondTools = await runCli(
        entrypoint,
        ["connect", "--config", secondConfigPath, "--project", secondProjectDir],
        env,
        request,
      );
      expect(firstTools.code, `${firstTools.stdout}\n${firstTools.stderr}`).toBe(0);
      expect(secondTools.code, `${secondTools.stdout}\n${secondTools.stderr}`).toBe(0);

      const parseTools = (result: CliResult) => {
        const line = result.stdout.trim().split("\n").at(-1);
        return (
          (
            JSON.parse(line ?? "{}") as { result?: { tools?: Array<{ name: string }> } }
          ).result?.tools?.map((tool) => tool.name) ?? []
        );
      };
      expect(parseTools(firstTools)).toContain("echo");
      expect(parseTools(firstTools)).not.toContain("add");
      expect(parseTools(secondTools)).toContain("add");
      expect(parseTools(secondTools)).not.toContain("echo");

      const hostManifest = JSON.parse(
        await readFile(resolve(stateDir, "routermcp", "host", "runtime.json"), "utf8"),
      ) as { controlUrl: string; localAuthToken: string };
      const issueWorkspaceGrant = async (workspaceId: string): Promise<string> => {
        const response = await fetch(
          new URL("/api/v1/management/handoff", `${hostManifest.controlUrl}/`),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${hostManifest.localAuthToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ workspaceId }),
          },
        );
        expect(response.status).toBe(201);
        return ((await response.json()) as { token: string }).token;
      };
      const firstWorkspaceId = getWorkspaceId(projectDir, configPath);
      const secondWorkspaceId = getWorkspaceId(secondProjectDir, secondConfigPath);
      const firstGrant = await issueWorkspaceGrant(firstWorkspaceId);
      const secondGrant = await issueWorkspaceGrant(secondWorkspaceId);
      const searchWorkspaceTools = (workspaceId: string, token: string) =>
        fetch(
          new URL(
            `/api/v1/workspaces/${workspaceId}/tools?query=type%3Atool&limit=20`,
            `${hostManifest.controlUrl}/`,
          ),
          { headers: { Authorization: `Bearer ${token}` } },
        );

      const firstSearch = await searchWorkspaceTools(firstWorkspaceId, firstGrant);
      expect(firstSearch.status).toBe(200);
      expect((await firstSearch.json()).results.map((tool: { name: string }) => tool.name)).toEqual(
        ["echo"],
      );

      const secondSearch = await searchWorkspaceTools(secondWorkspaceId, secondGrant);
      expect(secondSearch.status).toBe(200);
      expect(
        (await secondSearch.json()).results.map((tool: { name: string }) => tool.name),
      ).toEqual(["add"]);

      const crossWorkspaceSearch = await searchWorkspaceTools(secondWorkspaceId, firstGrant);
      expect(crossWorkspaceSearch.status).toBe(200);
      expect(
        (await crossWorkspaceSearch.json()).results.map((tool: { name: string }) => tool.name),
      ).toEqual(["add"]);
    } finally {
      const stopped = await runCli(
        entrypoint,
        ["stop", "--config", configPath, "--project", projectDir, ...common],
        env,
      );
      expect(stopped.code, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await cleanupTempDir(secondProjectDir);
    }
  }, 60_000);
});

async function runCli(
  entrypoint: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<CliResult> {
  const runtime = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "bun";
  const child = spawn(runtime, [entrypoint, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (input) {
    child.stdin.write(input);
    setTimeout(() => child.stdin.end(), 100);
  } else {
    child.stdin.end();
  }

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

  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
  });
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}
