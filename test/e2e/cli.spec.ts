import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getAvailablePort, waitForServer } from "../helpers/integration-utils.js";

const CLI_PATH = join(__dirname, "../../src/index.ts");
const FIXTURES_DIR = join(__dirname, "../fixtures");

function spawnCli(args: string[], options: { cwd?: string } = {}): ChildProcess {
  return spawn("bun", ["run", CLI_PATH, ...args], {
    cwd: options.cwd || join(__dirname, "../.."),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

async function readOutput(child: ChildProcess, timeout = 5000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const timeoutId = setTimeout(() => {
      resolve({ stdout, stderr });
    }, timeout);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", () => {
      clearTimeout(timeoutId);
      resolve({ stdout, stderr });
    });
  });
}

describe("CLI E2E - Help Command", () => {
  it("displays help with --help flag", async () => {
    const child = spawnCli(["--help"]);
    const { stdout } = await readOutput(child);

    expect(stdout).toContain("routermcp - MCP Gateway CLI");
    expect(stdout).toContain("COMMANDS:");
    expect(stdout).toContain("serve");
    expect(stdout).toContain("connect");
    expect(stdout).toContain("proxy");
    expect(stdout).toContain("tunnel");
  });

  it("displays help with -h flag", async () => {
    const child = spawnCli(["-h"]);
    const { stdout } = await readOutput(child);

    expect(stdout).toContain("routermcp - MCP Gateway CLI");
  });

  it("displays help with help command", async () => {
    const child = spawnCli(["help"]);
    const { stdout } = await readOutput(child);

    expect(stdout).toContain("USAGE:");
    expect(stdout).toContain("routermcp [command] [options]");
  });
});

describe("CLI E2E - Config Errors", () => {
  it("shows error when no config file exists", async () => {
    const child = spawnCli(["serve", "-c", "/nonexistent/config.jsonc"]);
    const { stderr } = await readOutput(child);

    expect(stderr).toContain("Error:");
    expect(stderr).toMatch(/config|not found/i);
  });
});

describe("CLI E2E - Gateway with server-everything", () => {
  let child: ChildProcess;
  let port: number;

  beforeAll(async () => {
    port = await getAvailablePort();
    const configPath = join(FIXTURES_DIR, "everything-server-config.jsonc");

    child = spawnCli(["serve", "-c", configPath, "--http", String(port)]);

    await waitForServer(`http://localhost:${port}/mcp`, 60000);
  }, 120000);

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("close", resolve));
    }
  });

  it("responds to tools/list request", async () => {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    expect(response.ok).toBe(true);
    const sessionId = response.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();

    const toolsResponse = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    const data = await toolsResponse.json();
    expect(data.result?.tools).toBeDefined();
    expect(data.result.tools.length).toBeGreaterThan(0);

    const toolNames = data.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("echo");
  });

  it("executes echo tool successfully", async () => {
    const initResponse = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    const sessionId = initResponse.headers.get("Mcp-Session-Id");

    const callResponse = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "Hello E2E Test!" },
        },
      }),
    });

    const data = await callResponse.json();
    expect(data.result).toBeDefined();
    expect(data.result.content).toBeDefined();
    expect(data.result.content[0].text).toContain("Hello E2E Test!");
  });

  it("lists prompts from server", async () => {
    const initResponse = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    const sessionId = initResponse.headers.get("Mcp-Session-Id");

    const promptsResponse = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/list",
        params: {},
      }),
    });

    const data = await promptsResponse.json();
    expect(data.result?.prompts).toBeDefined();
    expect(data.result.prompts.length).toBeGreaterThan(0);
  });
});

describe("CLI E2E - Telemetry Commands", () => {
  it("shows telemetry status", async () => {
    const child = spawnCli(["telemetry", "status"]);
    const { stdout } = await readOutput(child);

    expect(stdout).toContain("Telemetry Status");
    expect(stdout).toMatch(/Enabled:\s+(Yes|No)/);
  });
});
