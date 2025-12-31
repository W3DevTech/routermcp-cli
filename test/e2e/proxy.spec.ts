import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getAvailablePort, waitForHealthy } from "../helpers/integration-utils.js";

const CLI_PATH = join(__dirname, "../../src/index.ts");

function spawnCli(args: string[], options: { cwd?: string } = {}): ChildProcess {
  return spawn("bun", ["run", CLI_PATH, ...args], {
    cwd: options.cwd || join(__dirname, "../.."),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

async function killProcess(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return;

  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");

    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 5000);
  });
}

describe("Proxy E2E - SSE Transport", () => {
  let child: ChildProcess;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = await getAvailablePort();
    baseUrl = `http://localhost:${port}`;

    child = spawnCli([
      "proxy",
      "--stdio",
      "npx -y @modelcontextprotocol/server-everything",
      "--port",
      String(port),
      "--outputTransport",
      "sse",
    ]);

    await waitForHealthy(`${baseUrl}/health`, 60000);
  }, 120000);

  afterAll(async () => {
    await killProcess(child);
  });

  it("health endpoint returns ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.transport).toBe("sse");
    expect(data.childProcess.running).toBe(true);
  });

  it("SSE endpoint is accessible", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${baseUrl}/sse`, {
        signal: controller.signal,
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it("reports uptime in health response", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const data = await response.json();

    expect(data.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe("Proxy E2E - Error Handling", () => {
  it("fails gracefully when --stdio is missing", async () => {
    const child = spawnCli(["proxy"]);

    const output = await new Promise<string>((resolve) => {
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("close", () => resolve(stderr));
    });

    expect(output).toContain("--stdio is required");
  });
});
