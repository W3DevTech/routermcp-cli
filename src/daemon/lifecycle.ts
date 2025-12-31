import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { DaemonPaths } from "./paths.js";
import { isWindows } from "./paths.js";

const DAEMON_STARTUP_TIMEOUT = 10000;
const DAEMON_HEALTH_CHECK_INTERVAL = 100;
const DEFAULT_DAEMON_PORT = 5151;

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  socket?: string;
}

export async function getDaemonStatus(paths: DaemonPaths): Promise<DaemonStatus> {
  if (!existsSync(paths.pid)) {
    return { running: false };
  }

  try {
    const pidStr = readFileSync(paths.pid, "utf-8").trim();
    const pid = Number.parseInt(pidStr, 10);

    if (!isProcessRunning(pid)) {
      cleanupDaemonFiles(paths);
      return { running: false };
    }

    let port: number | undefined;
    let socket: string | undefined;

    if (existsSync(paths.port)) {
      const portStr = readFileSync(paths.port, "utf-8").trim();
      port = Number.parseInt(portStr, 10);
    }

    if (!isWindows() && existsSync(paths.socket)) {
      socket = paths.socket;
    }

    return { running: true, pid, port, socket };
  } catch {
    return { running: false };
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(paths: DaemonPaths, verbose = false): Promise<DaemonStatus> {
  mkdirSync(paths.dir, { recursive: true });

  const args = [
    "serve",
    "--config",
    paths.configPath,
    "--daemon-mode",
    "--http",
    String(DEFAULT_DAEMON_PORT),
  ];

  if (verbose) {
    args.push("--verbose");
  }

  const child = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ROUTERMCP_DAEMON: "1" },
  });

  child.unref();

  if (child.pid) {
    writeFileSync(paths.pid, String(child.pid));
  }

  return waitForDaemonReady(paths);
}

async function waitForDaemonReady(paths: DaemonPaths): Promise<DaemonStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < DAEMON_STARTUP_TIMEOUT) {
    const status = await getDaemonStatus(paths);
    if (status.running && (status.port || status.socket)) {
      return status;
    }
    await sleep(DAEMON_HEALTH_CHECK_INTERVAL);
  }

  throw new Error("Daemon failed to start within timeout");
}

export async function stopDaemon(paths: DaemonPaths): Promise<void> {
  const status = await getDaemonStatus(paths);

  if (!status.running || !status.pid) {
    cleanupDaemonFiles(paths);
    return;
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process already dead
  }

  const startTime = Date.now();
  while (Date.now() - startTime < 5000) {
    if (!isProcessRunning(status.pid)) {
      break;
    }
    await sleep(100);
  }

  if (isProcessRunning(status.pid)) {
    try {
      process.kill(status.pid, "SIGKILL");
    } catch {
      // Ignore
    }
  }

  cleanupDaemonFiles(paths);
}

export function cleanupDaemonFiles(paths: DaemonPaths): void {
  const files = [paths.pid, paths.port, paths.socket];
  for (const file of files) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function connectToSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      resolve(false);
    });

    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
