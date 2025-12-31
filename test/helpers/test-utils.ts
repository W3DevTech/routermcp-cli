import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RouterMcpConfig } from "../../src/config/types.js";

export async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routermcp-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeConfigFile(
  dir: string,
  config: RouterMcpConfig,
  filename = "routermcp.jsonc",
): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

export async function createTestProjectDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await createTempDir();
  return {
    dir,
    cleanup: () => cleanupTempDir(dir),
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBasicConfig(
  servers: Record<string, { command: string; args?: string[] }>,
): RouterMcpConfig {
  const mcpServers: RouterMcpConfig["mcpServers"] = {};
  for (const [name, config] of Object.entries(servers)) {
    mcpServers[name] = {
      transport: "stdio",
      command: config.command,
      args: config.args,
    };
  }
  return { mcpServers };
}

export function createHttpConfig(
  servers: Record<string, { url: string; headers?: Record<string, string> }>,
): RouterMcpConfig {
  const mcpServers: RouterMcpConfig["mcpServers"] = {};
  for (const [name, config] of Object.entries(servers)) {
    mcpServers[name] = {
      transport: "http-streamable",
      url: config.url,
      headers: config.headers,
    };
  }
  return { mcpServers };
}

export function createFilteredConfig(
  serverName: string,
  filters: {
    allowedTools?: string[];
    denyTools?: string[];
    allowedToolsGlob?: string[];
    denyToolsGlob?: string[];
  },
): RouterMcpConfig {
  return {
    mcpServers: {
      [serverName]: {
        transport: "stdio",
        command: "echo",
        args: ["test"],
        ...filters,
      },
    },
  };
}

export async function getAvailablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not get port"));
      }
    });
    server.on("error", reject);
  });
}

export class TestLogger {
  logs: string[] = [];
  errors: string[] = [];

  log(message: string): void {
    this.logs.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  clear(): void {
    this.logs = [];
    this.errors = [];
  }

  hasLog(pattern: string | RegExp): boolean {
    return this.logs.some((log) =>
      typeof pattern === "string" ? log.includes(pattern) : pattern.test(log),
    );
  }

  hasError(pattern: string | RegExp): boolean {
    return this.errors.some((err) =>
      typeof pattern === "string" ? err.includes(pattern) : pattern.test(err),
    );
  }
}
