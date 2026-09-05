import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RouterMcpConfig } from "../../../src/config/types.js";
import { parseConfigContent } from "../../../src/config/loader.js";
import type { Gateway } from "../../../src/core/gateway.js";
import {
  WorkspaceRuntimeBusyError,
  WorkspaceRuntimeManager,
  type WorkspaceRuntimeContext,
  type WorkspaceRuntimeResource,
} from "../../../src/daemon/workspace-runtime.js";

function config(serverName: string, command = "server"): RouterMcpConfig {
  return {
    mcpServers: {
      [serverName]: { transport: "stdio", command },
    },
  };
}

function fakeResource() {
  const stop = vi.fn().mockResolvedValue(undefined);
  const gateway = { stop } as unknown as Gateway;
  return { resource: { gateway } satisfies WorkspaceRuntimeResource, stop };
}

async function makeWorkspace(name: string) {
  const directory = resolve("/tmp", `routermcp-runtime-${name}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "routermcp.jsonc");
  await writeFile(configPath, "{}", "utf8");
  return { directory, configPath };
}

describe("WorkspaceRuntimeManager", () => {
  it("keeps different project configs, tools, cwd, and env in separate single-flight runtimes", async () => {
    const workspaceA = await makeWorkspace("a");
    const workspaceB = await makeWorkspace("b");
    const contexts: WorkspaceRuntimeContext[] = [];
    const resources: ReturnType<typeof fakeResource>[] = [];

    const manager = new WorkspaceRuntimeManager({
      factory: async (context) => {
        contexts.push(context);
        const result = fakeResource();
        resources.push(result);
        return result.resource;
      },
    });

    const inputA = {
      ...workspaceA,
      config: config("alpha", "/alpha-server"),
      cwd: "src",
      env: { ROUTERMCP_RUNTIME_MARKER: "a" },
    };
    const inputB = {
      ...workspaceB,
      config: config("beta", "/beta-server"),
      cwd: "tools",
      env: { ROUTERMCP_RUNTIME_MARKER: "b" },
    };

    const [runtimeA1, runtimeA2, runtimeB] = await Promise.all([
      manager.getOrCreate(inputA),
      manager.getOrCreate(inputA),
      manager.getOrCreate(inputB),
    ]);

    expect(runtimeA1).toBe(runtimeA2);
    expect(runtimeA1).not.toBe(runtimeB);
    expect(contexts).toHaveLength(2);

    const contextA = contexts.find((context) => context.config.mcpServers.alpha);
    const contextB = contexts.find((context) => context.config.mcpServers.beta);
    expect(contextA?.config.mcpServers.alpha.command).toBe("/alpha-server");
    expect(contextB?.config.mcpServers.beta.command).toBe("/beta-server");
    expect(contextA?.execution.cwd).toBe(join(workspaceA.directory, "src"));
    expect(contextB?.execution.cwd).toBe(join(workspaceB.directory, "tools"));
    expect(contextA?.execution.env.ROUTERMCP_RUNTIME_MARKER).toBe("a");
    expect(contextB?.execution.env.ROUTERMCP_RUNTIME_MARKER).toBe("b");
    expect(contextA?.execution.env).not.toBe(contextB?.execution.env);

    await manager.disposeAll();
    expect(resources.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
  });

  it("isolates a failed context and retries it without rebuilding a healthy context", async () => {
    const workspaceA = await makeWorkspace("healthy");
    const workspaceB = await makeWorkspace("retry");
    let failB = true;
    const created: string[] = [];
    const manager = new WorkspaceRuntimeManager({
      factory: async (context) => {
        created.push(context.id);
        if (context.config.mcpServers.broken && failB) {
          throw new Error("broken upstream");
        }
        return fakeResource().resource;
      },
    });

    const inputA = { ...workspaceA, config: config("healthy") };
    const inputB = { ...workspaceB, config: config("broken") };
    const runtimeA = await manager.getOrCreate(inputA);
    await expect(manager.getOrCreate(inputB)).rejects.toThrow("broken upstream");

    expect(manager.get(runtimeA.context.id)).toBe(runtimeA);
    expect(manager.getSnapshot(runtimeA.context.id)?.state).toBe("ready");
    expect(manager.listSnapshots().find((snapshot) => snapshot.configPath === workspaceB.configPath)?.state).toBe(
      "failed",
    );

    failB = false;
    await manager.getOrCreate(inputB);
    expect(created.filter((id) => id === runtimeA.context.id)).toHaveLength(1);
    expect(created).toHaveLength(3);

    await manager.disposeAll();
  });

  it("preserves the initial execution environment during reload and disposes idle leases", async () => {
    const workspace = await makeWorkspace("reload");
    const contexts: WorkspaceRuntimeContext[] = [];
    const resources: ReturnType<typeof fakeResource>[] = [];
    const manager = new WorkspaceRuntimeManager({
      idleTimeoutMs: 1,
      factory: async (context) => {
        contexts.push(context);
        const result = fakeResource();
        resources.push(result);
        return result.resource;
      },
    });

    const first = await manager.acquire({
      ...workspace,
      config: config("first"),
      env: { ROUTERMCP_RUNTIME_MARKER: "initial" },
    });
    const reloaded = await manager.reload({
      ...workspace,
      config: config("second"),
      configDigest: "second-revision",
      env: { ROUTERMCP_RUNTIME_MARKER: "must-not-replace" },
    });

    expect(reloaded).not.toBe(first.runtime);
    expect(contexts[1]?.config.mcpServers.second).toBeDefined();
    expect(contexts[1]?.execution.env.ROUTERMCP_RUNTIME_MARKER).toBe("initial");

    await first.release();
    // The old gateway drains with the active lease instead of being stopped
    // underneath an in-flight request.
    expect(resources[0]?.stop).toHaveBeenCalledTimes(1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(resources[1]?.stop).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot(first.workspaceId)?.state).toBe("disposed");
  });

  it("restores the last healthy context when a replacement runtime fails", async () => {
    const workspace = await makeWorkspace("failed-reload");
    let failReplacement = false;
    const manager = new WorkspaceRuntimeManager({
      factory: async (context) => {
        if (context.config.mcpServers.replacement && failReplacement) {
          throw new Error("replacement upstream failed");
        }
        return fakeResource().resource;
      },
    });
    const firstInput = {
      ...workspace,
      config: config("initial"),
      configDigest: "initial-revision",
    };
    const first = await manager.getOrCreate(firstInput);
    failReplacement = true;

    await expect(
      manager.reload({
        ...workspace,
        config: config("replacement"),
        configDigest: "replacement-revision",
      }),
    ).rejects.toThrow("replacement upstream failed");

    expect(manager.getSnapshot(first.context.id)).toMatchObject({
      state: "ready",
      configDigest: "initial-revision",
    });
    await expect(manager.getOrCreate(firstInput)).resolves.toBe(first);
    await manager.disposeAll();
  });

  it("rejects disposal while a lease is active", async () => {
    const workspace = await makeWorkspace("busy");
    const manager = new WorkspaceRuntimeManager({ factory: async () => fakeResource().resource });
    const lease = await manager.acquire({ ...workspace, config: config("busy") });

    await expect(manager.dispose(lease.runtime.context.key)).rejects.toBeInstanceOf(
      WorkspaceRuntimeBusyError,
    );
    await lease.release();
    await manager.dispose(lease.runtime.context.key);
  });
});

describe("runtime-scoped config expansion", () => {
  it("expands config variables from the supplied environment snapshot", () => {
    const parsed = parseConfigContent(
      JSON.stringify({
        mcpServers: {
          scoped: { transport: "stdio", command: "${env:RUNTIME_COMMAND}" },
        },
      }),
      "/tmp/scoped.jsonc",
      { env: { RUNTIME_COMMAND: "from-context" } },
    );

    expect(parsed.mcpServers.scoped.command).toBe("from-context");
  });
});
