import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { type Interface, createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Result of running a CLI command
 */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

/**
 * Options for spawning CLI process
 */
export interface SpawnCliOptions {
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Input to write to stdin */
  input?: string;
}

/**
 * Spawns the CLI with given arguments and returns the child process
 * Useful for interactive testing where you need to control stdin/stdout
 */
export function spawnCli(args: string[], options: SpawnCliOptions = {}): ChildProcess {
  const { env = {}, cwd } = options;

  const child = spawn("bun", ["run", "src/index.ts", ...args], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return child;
}

/**
 * Runs the CLI and waits for it to complete
 * Returns stdout, stderr, and exit code
 */
export async function runCli(
  args: string[],
  options: SpawnCliOptions = {},
): Promise<CommandResult> {
  const { timeout = 30000, input } = options;

  return new Promise((resolve) => {
    const child = spawnCli(args, options);

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        killed,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        killed: false,
      });
    });
  });
}

/**
 * Reads a single JSON-RPC message from a stream
 */
export async function readJsonLine(stream: Readable): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stream });

    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error("Timeout waiting for JSON line"));
    }, 10000);

    rl.once("line", (line) => {
      clearTimeout(timeout);
      rl.close();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error(`Failed to parse JSON: ${line}`));
      }
    });

    rl.once("close", () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Writes a JSON-RPC message to a stream
 */
export function writeJsonLine(stream: Writable, data: unknown): void {
  stream.write(`${JSON.stringify(data)}\n`);
}

/**
 * Creates a mock for process.exit that captures the exit code
 * instead of actually exiting
 */
export function mockProcessExit(): { exitCode: number | null; restore: () => void } {
  const originalExit = process.exit;
  const state = { exitCode: null as number | null };

  (process as { exit: (code?: number) => never }).exit = (code?: number): never => {
    state.exitCode = code ?? 0;
    throw new Error(`process.exit(${code}) called`);
  };

  return {
    get exitCode() {
      return state.exitCode;
    },
    restore: () => {
      process.exit = originalExit;
    },
  };
}

/**
 * Creates a mock for console.error that captures output
 */
export function mockConsoleError(): { errors: string[]; restore: () => void } {
  const originalError = console.error;
  const errors: string[] = [];

  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };

  return {
    errors,
    restore: () => {
      console.error = originalError;
    },
  };
}

/**
 * Creates a mock for console.log that captures output
 */
export function mockConsoleLog(): { logs: string[]; restore: () => void } {
  const originalLog = console.log;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };

  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

/**
 * Waits for a condition to be true, with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Creates a test config file in a temp directory and returns the path
 */
export async function createTestConfig(
  content: Record<string, unknown>,
  tempDir: string,
  filename = "routermcp.jsonc",
): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const configPath = join(tempDir, filename);
  await writeFile(configPath, JSON.stringify(content, null, 2));
  return configPath;
}
