import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeInvocation,
  isCompiledBunEntrypoint,
} from "../../../src/daemon/lifecycle.js";
import { buildManagedRestartInvocation } from "../../../src/cli/serve.js";

const compiledEntrypoint = "/$bunfs/root/routermcp";

describe("compiled Bun daemon invocations", () => {
  it("recognizes Bun's virtual compiled entrypoint", () => {
    expect(isCompiledBunEntrypoint(compiledEntrypoint)).toBe(true);
    expect(isCompiledBunEntrypoint("/tmp/routermcp/src/index.ts")).toBe(false);
    expect(isCompiledBunEntrypoint("C:\\tmp\\routermcp\\src\\index.ts")).toBe(false);
  });

  it("omits the virtual entrypoint from spawned daemon argv", () => {
    expect(
      buildRuntimeInvocation(compiledEntrypoint, [
        "serve",
        "--config",
        "/tmp/project/routermcp.jsonc",
      ]),
    ).toEqual({
      command: process.execPath,
      args: ["serve", "--config", "/tmp/project/routermcp.jsonc"],
    });
  });

  it("retains the script argument for source TypeScript invocations", () => {
    const script = resolve("/tmp/project/src/index.ts");
    const invocation = buildRuntimeInvocation(script, ["serve", "--daemon-mode"]);

    expect(invocation.command).toBe("bun");
    expect(invocation.args).toEqual([script, "serve", "--daemon-mode"]);
  });

  it("omits the virtual entrypoint from managed restart argv", () => {
    expect(
      buildManagedRestartInvocation(
        compiledEntrypoint,
        { projectPath: "/tmp/project" },
        { configPath: "/tmp/project/routermcp.jsonc", host: "127.0.0.1", port: 7858 },
        true,
      ),
    ).toEqual({
      command: process.execPath,
      args: [
        "restart",
        "--config",
        "/tmp/project/routermcp.jsonc",
        "--project",
        "/tmp/project",
        "--host",
        "127.0.0.1",
        "--port",
        "7858",
        "--verbose",
      ],
    });
  });

  it("retains the script argument for source managed restarts", () => {
    const script = resolve("/tmp/project/src/index.ts");
    const invocation = buildManagedRestartInvocation(
      script,
      { projectPath: "/tmp/project" },
      { configPath: "/tmp/project/routermcp.jsonc", host: "127.0.0.1", port: 7858 },
      false,
    );

    expect(invocation.command).toBe("bun");
    expect(invocation.args).toEqual([
      script,
      "restart",
      "--config",
      "/tmp/project/routermcp.jsonc",
      "--project",
      "/tmp/project",
      "--host",
      "127.0.0.1",
      "--port",
      "7858",
    ]);
  });
});
