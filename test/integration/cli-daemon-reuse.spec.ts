import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const statusManifest = JSON.parse(status.stdout) as {
      pid?: number;
      instanceId?: string;
      state?: string;
    };
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
