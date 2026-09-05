import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { extname, resolve } from "node:path";
import { VERSION } from "../version.js";
import { DAEMON_HEALTH_PATH } from "../transports/http-streamable.js";
import { fingerprintConfigFile } from "./fingerprint.js";
import {
  isProcessRunning,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./identity.js";
import {
  acquireProfileLock,
  DEFAULT_LOCK_TIMEOUT_MS,
} from "./lock.js";
import type { DaemonPaths } from "./paths.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type RuntimeManifest,
  readRuntimeManifest,
  redactRuntimeManifest,
  removeRuntimeManifest,
  writeRuntimeManifest,
} from "./runtime-manifest.js";
import { type ReadinessSnapshot, transitionReadiness } from "./readiness.js";

export const DAEMON_STARTUP_TIMEOUT_MS = 15_000;
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DAEMON_FORCE_SHUTDOWN_TIMEOUT_MS = 2_000;
export const DEFAULT_DAEMON_PORT = 7858;
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

export interface DaemonStatus {
  running: boolean;
  state?: RuntimeManifest["state"] | "stopped";
  pid?: number;
  port?: number;
  host?: string;
  socket?: string;
  profileId?: string;
  instanceId?: string;
  cliVersion?: string;
  protocolVersion?: string;
  configPath?: string;
  configFingerprint?: string;
  mcpUrl?: string;
  controlUrl?: string;
  /**
   * Private token for callers running in the same user context. It is kept
   * outside `manifest`, which is always redacted before status is printed.
   */
  authToken?: string;
  manifest?: ReturnType<typeof redactRuntimeManifest>;
  reason?: string;
}

export interface DaemonStatusOptions {
  /** Fingerprint of the currently resolved config, if already available. */
  configFingerprint?: string;
  /** Maximum time to wait for the authenticated health response. */
  healthTimeoutMs?: number;
}

export interface EnsureRunningOptions extends DaemonStatusOptions {
  verbose?: boolean;
  preferredPort?: number;
  host?: string;
  startupTimeoutMs?: number;
  lockTimeoutMs?: number;
  projectPath?: string;
  /** Override the executable entrypoint for embedders and integration tests. */
  entrypoint?: string;
}

export interface StopDaemonOptions {
  lockTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  forceShutdownTimeoutMs?: number;
}

export class DaemonStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonStartupError";
  }
}

export class DaemonStopTimeoutError extends Error {
  constructor(pid: number) {
    super(`Daemon process ${pid} did not stop within the shutdown grace period`);
    this.name = "DaemonStopTimeoutError";
  }
}

const LEGACY_DAEMON_STATE_REASON =
  "A legacy RouterMCP daemon appears to be running; stop it before starting the managed daemon";

/**
 * Inspect one profile's runtime manifest and verify the daemon over its
 * authenticated loopback health endpoint. A PID file alone is never treated
 * as proof that the expected RouterMCP daemon is running.
 */
export async function getDaemonStatus(
  paths: DaemonPaths,
  options: DaemonStatusOptions = {},
): Promise<DaemonStatus> {
  const manifest = await readRuntimeManifest(paths.runtimeManifest);
  if (!manifest) {
    return readLegacyDaemonStatus(paths);
  }

  const baseStatus = toDaemonStatus(manifest, false);

  if (
    manifest.profileId !== paths.profileId ||
    resolve(manifest.configPath) !== resolve(paths.configPath)
  ) {
    return { ...baseStatus, reason: "Runtime manifest belongs to another profile" };
  }

  if (
    options.configFingerprint !== undefined &&
    manifest.configFingerprint !== options.configFingerprint
  ) {
    return { ...baseStatus, reason: "Configuration fingerprint changed" };
  }

  if (manifest.cliVersion !== VERSION) {
    return {
      ...baseStatus,
      reason: `Daemon CLI version mismatch (running ${manifest.cliVersion}, current ${VERSION})`,
    };
  }

  if (manifest.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    return {
      ...baseStatus,
      reason: `Daemon protocol version mismatch (running ${manifest.protocolVersion}, current ${DAEMON_PROTOCOL_VERSION})`,
    };
  }

  if (manifest.state !== "ready") {
    return { ...baseStatus, reason: `Daemon is ${manifest.state}` };
  }

  if (!manifest.readyAt) {
    return { ...baseStatus, reason: "Daemon ready manifest is missing readyAt" };
  }

  if (!isLoopbackHost(manifest.host) || !isValidPort(manifest.port)) {
    return { ...baseStatus, reason: "Daemon manifest has an invalid loopback host or port" };
  }

  if (!manifestEndpointsMatch(manifest)) {
    return { ...baseStatus, reason: "Daemon manifest has invalid MCP or control endpoints" };
  }

  if (!(await matchesProcessIdentity(manifest.processIdentity))) {
    await removeManifestIfCurrent(paths, manifest);
    return { ...baseStatus, reason: "Daemon process is no longer running" };
  }

  const descriptor = await probeHealth(manifest, options.healthTimeoutMs);
  if (!descriptor) {
    return { ...baseStatus, reason: "Authenticated daemon health check failed" };
  }

  if (
    descriptor.instanceId !== manifest.instanceId ||
    descriptor.profileId !== manifest.profileId ||
    descriptor.pid !== manifest.pid ||
    descriptor.state !== "ready" ||
    descriptor.cliVersion !== manifest.cliVersion ||
    descriptor.protocolVersion !== manifest.protocolVersion ||
    descriptor.configFingerprint !== manifest.configFingerprint ||
    descriptor.host !== manifest.host ||
    descriptor.port !== manifest.port ||
    descriptor.readyAt !== manifest.readyAt
  ) {
    return { ...baseStatus, reason: "Daemon health descriptor did not match manifest" };
  }

  return { ...baseStatus, running: true };
}

/**
 * Ensure exactly one daemon exists for a profile. The lock covers the full
 * check/start/readiness window, so concurrent clients either observe the
 * existing ready instance or wait for the first starter to publish it.
 */
export async function ensureRunning(
  paths: DaemonPaths,
  options: EnsureRunningOptions = {},
): Promise<DaemonStatus> {
  const lock = await acquireProfileLock(paths.lock, {
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  });

  try {
    const configFingerprint =
      options.configFingerprint ?? (await fingerprintConfigFile(paths.configPath));
    const status = await getDaemonStatus(paths, {
      configFingerprint,
      healthTimeoutMs: options.healthTimeoutMs,
    });
    if (status.running) {
      return status;
    }

    if (status.reason === LEGACY_DAEMON_STATE_REASON && status.pid) {
      throw new DaemonStartupError(`${status.reason} (pid ${status.pid})`);
    }

    const existing = await readRuntimeManifest(paths.runtimeManifest);
    if (existing) {
      if (belongsToPaths(existing, paths)) {
        await stopKnownDaemon(paths, existing, {
          forceShutdownTimeoutMs: DAEMON_FORCE_SHUTDOWN_TIMEOUT_MS,
        });
      } else {
        await removeRuntimeManifest(paths.runtimeManifest);
      }
    }

    return await spawnAndWaitForDaemon(paths, {
      ...options,
      configFingerprint,
    });
  } finally {
    await lock.release();
  }
}

/** Backwards-compatible entry point used by connect.ts. */
export async function startDaemon(
  paths: DaemonPaths,
  verbose = false,
  options: Omit<EnsureRunningOptions, "verbose"> = {},
): Promise<DaemonStatus> {
  return ensureRunning(paths, { ...options, verbose });
}

/** Stop only the process identified by this profile's manifest. */
export async function stopDaemon(
  paths: DaemonPaths,
  options: StopDaemonOptions = {},
): Promise<void> {
  const lock = await acquireProfileLock(paths.lock, {
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  });

  try {
    const manifest = await readRuntimeManifest(paths.runtimeManifest);
    if (!manifest) {
      const legacy = await readLegacyDaemonStatus(paths);
      if (legacy.reason === LEGACY_DAEMON_STATE_REASON && legacy.pid) {
        throw new DaemonStartupError(`${legacy.reason} (pid ${legacy.pid})`);
      }
      cleanupDaemonFiles(paths);
      return;
    }

    if (!belongsToPaths(manifest, paths)) {
      await removeRuntimeManifest(paths.runtimeManifest);
      cleanupDaemonFiles(paths);
      return;
    }

    await stopKnownDaemon(paths, manifest, options);
  } finally {
    await lock.release();
  }
}

async function readLegacyDaemonStatus(paths: DaemonPaths): Promise<DaemonStatus> {
  const pid = await readPositiveInteger(paths.pid);
  const port = await readPositiveInteger(paths.port);
  if (pid && isProcessRunning(pid)) {
    return {
      running: false,
      state: "stopped",
      pid,
      ...(port ? { port } : {}),
      reason: LEGACY_DAEMON_STATE_REASON,
    };
  }

  cleanupDaemonFiles(paths);
  return { running: false, reason: "No valid runtime manifest" };
}

async function readPositiveInteger(path: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Restart one profile while retaining the single-owner lifecycle lock. */
export async function restartDaemon(
  paths: DaemonPaths,
  options: EnsureRunningOptions = {},
): Promise<DaemonStatus> {
  const lock = await acquireProfileLock(paths.lock, {
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  });

  try {
    const existing = await readRuntimeManifest(paths.runtimeManifest);
    if (existing && belongsToPaths(existing, paths)) {
      await stopKnownDaemon(paths, existing, options);
    } else if (existing) {
      await removeRuntimeManifest(paths.runtimeManifest);
    }

    const configFingerprint =
      options.configFingerprint ?? (await fingerprintConfigFile(paths.configPath));
    return await spawnAndWaitForDaemon(paths, {
      ...options,
      configFingerprint,
    });
  } finally {
    await lock.release();
  }
}

/**
 * Preserve the legacy cleanup helper for callers that still have old pid,
 * port, or socket files. New lifecycle code removes runtime.json only after
 * verifying its instance identity.
 */
export function cleanupDaemonFiles(paths: DaemonPaths): void {
  for (const file of [paths.pid, paths.port, paths.socket]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // Cleanup is best effort after a process has exited.
    }
  }
}

export async function connectToSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection(socketPath);

    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });

    socket.once("error", () => {
      resolveConnection(false);
    });

    setTimeout(() => {
      socket.destroy();
      resolveConnection(false);
    }, 1000);
  });
}

export { isProcessRunning };

async function spawnAndWaitForDaemon(
  paths: DaemonPaths,
  options: EnsureRunningOptions & { configFingerprint: string },
): Promise<DaemonStatus> {
  mkdirSync(paths.dir, { recursive: true });

  let logFd: number | undefined;
  try {
    logFd = openSync(paths.log, "a", 0o600);
    chmodSync(paths.log, 0o600);
  } catch (error) {
    throw new DaemonStartupError(
      `Unable to open daemon log at ${paths.log}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const script = options.entrypoint
    ? resolve(options.entrypoint)
    : process.argv[1]
      ? resolve(process.argv[1])
      : undefined;
  if (!script) {
    closeSync(logFd);
    throw new DaemonStartupError("Unable to determine the RouterMCP CLI entrypoint");
  }

  const preferredPort = options.preferredPort ?? DEFAULT_DAEMON_PORT;
  const host = options.host ?? DEFAULT_DAEMON_HOST;
  const projectPath = options.projectPath ?? paths.projectPath ?? process.cwd();
  const args = [
    "serve",
    "--config",
    paths.configPath,
    "--project",
    projectPath,
    "--daemon-mode",
    "--http",
    String(preferredPort),
    "--host",
    host,
  ];
  if (options.verbose) {
    args.push("--verbose");
  }

  const invocation = buildRuntimeInvocation(script, args);
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: projectPath,
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      env: {
        ...process.env,
        ROUTERMCP_DAEMON: "1",
        // The supervisor owns the profile lock while this child reaches ready.
        // This prevents the child from deadlocking against its starter while
        // still allowing a manually launched daemon to acquire the lock.
        ROUTERMCP_DAEMON_LOCK_HELD: "1",
      },
    });
  } catch (error) {
    closeSync(logFd);
    throw new DaemonStartupError(
      `Unable to spawn daemon: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  closeSync(logFd);

  if (!child.pid) {
    throw new DaemonStartupError("Daemon process did not provide a PID");
  }

  const timeoutMs = options.startupTimeoutMs ?? DAEMON_STARTUP_TIMEOUT_MS;
  return waitForDaemonReady(paths, child, options.configFingerprint, timeoutMs);
}

async function waitForDaemonReady(
  paths: DaemonPaths,
  child: ChildProcess,
  configFingerprint: string,
  timeoutMs: number,
): Promise<DaemonStatus> {
  let exitCode: number | null = null;
  let spawnError: unknown = null;
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });
  child.once("exit", (code) => {
    exitCode = code ?? 0;
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentSpawnError: unknown = spawnError;
    if (currentSpawnError) {
      await cleanupFailedStartup(paths, child.pid);
      throw new DaemonStartupError(
        `Daemon failed to spawn: ${currentSpawnError instanceof Error ? currentSpawnError.message : String(currentSpawnError)}`,
      );
    }
    if (exitCode !== null) {
      await cleanupFailedStartup(paths, child.pid);
      throw new DaemonStartupError(`Daemon exited during startup with code ${exitCode}`);
    }

    const status = await getDaemonStatus(paths, { configFingerprint, healthTimeoutMs: 500 });
    if (status.running) {
      return status;
    }

    await sleep(100);
  }

  if (child.pid && isProcessRunning(child.pid)) {
    killProcess(child.pid, "SIGTERM");
    await waitForPidExit(child.pid, DAEMON_SHUTDOWN_TIMEOUT_MS);
  }
  if (child.pid && isProcessRunning(child.pid)) {
    killProcess(child.pid, "SIGKILL");
    await waitForPidExit(child.pid, DAEMON_FORCE_SHUTDOWN_TIMEOUT_MS);
  }
  await cleanupFailedStartup(paths, child.pid);
  throw new DaemonStartupError(
    `Daemon failed to become ready within ${timeoutMs}ms; see ${paths.log}`,
  );
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

/**
 * Remove startup state owned by a child that exited or timed out before it
 * could publish a ready manifest. The PID check prevents a failed starter
 * from deleting a manifest written by a later process.
 */
async function cleanupFailedStartup(paths: DaemonPaths, childPid: number | undefined): Promise<void> {
  if (!childPid) return;

  const manifest = await readRuntimeManifest(paths.runtimeManifest);
  if (manifest?.pid === childPid && manifest.processIdentity.pid === childPid) {
    await removeManifestIfCurrent(paths, manifest);
  }
  cleanupDaemonFiles(paths);
}

async function stopKnownDaemon(
  paths: DaemonPaths,
  manifest: RuntimeManifest,
  options: StopDaemonOptions = {},
): Promise<void> {
  const current = await readRuntimeManifest(paths.runtimeManifest);
  if (!current || current.instanceId !== manifest.instanceId) {
    return;
  }

  const ownsPid = await matchesProcessIdentity(current.processIdentity);
  if (!ownsPid) {
    await removeManifestIfCurrent(paths, current);
    cleanupDaemonFiles(paths);
    return;
  }

  const currentReadiness: ReadinessSnapshot = {
    state: current.state,
    startedAt: current.startedAt,
    updatedAt: current.updatedAt,
    ...(current.readyAt ? { readyAt: current.readyAt } : {}),
    ...(current.failedAt ? { failedAt: current.failedAt } : {}),
    ...(current.stoppingAt ? { stoppingAt: current.stoppingAt } : {}),
    ...(current.error ? { error: current.error } : {}),
  };
  const stopping =
    current.state === "stopping"
      ? currentReadiness
      : transitionReadiness(currentReadiness, "stopping");
  await writeRuntimeManifest(paths.runtimeManifest, {
    ...current,
    ...stopping,
  });

  killProcess(current.pid, "SIGTERM");
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
  if (await waitForProcessExit(current.processIdentity, shutdownTimeoutMs)) {
    await removeManifestIfCurrent(paths, current);
    cleanupDaemonFiles(paths);
    return;
  }

  killProcess(current.pid, "SIGKILL");
  const forceTimeoutMs = options.forceShutdownTimeoutMs ?? DAEMON_FORCE_SHUTDOWN_TIMEOUT_MS;
  if (!(await waitForProcessExit(current.processIdentity, forceTimeoutMs))) {
    throw new DaemonStopTimeoutError(current.pid);
  }

  await removeManifestIfCurrent(paths, current);
  cleanupDaemonFiles(paths);
}

async function waitForProcessExit(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await matchesProcessIdentity(identity))) {
      return true;
    }
    await sleep(100);
  }
  return !(await matchesProcessIdentity(identity));
}

async function removeManifestIfCurrent(
  paths: DaemonPaths,
  expected: { instanceId: string },
): Promise<void> {
  const current = await readRuntimeManifest(paths.runtimeManifest);
  if (current?.instanceId === expected.instanceId) {
    await removeRuntimeManifest(paths.runtimeManifest);
  }
}

function belongsToPaths(manifest: RuntimeManifest, paths: DaemonPaths): boolean {
  return (
    manifest.profileId === paths.profileId &&
    resolve(manifest.configPath) === resolve(paths.configPath)
  );
}

function toDaemonStatus(manifest: RuntimeManifest, running: boolean): DaemonStatus {
  const endpoints = daemonEndpoints(manifest.host, manifest.port);
  return {
    running,
    state: manifest.state,
    pid: manifest.pid,
    port: manifest.port,
    host: manifest.host,
    socket: manifest.socketPath,
    profileId: manifest.profileId,
    instanceId: manifest.instanceId,
    cliVersion: manifest.cliVersion,
    protocolVersion: manifest.protocolVersion,
    configPath: manifest.configPath,
    configFingerprint: manifest.configFingerprint,
    ...(endpoints.mcpUrl ? { mcpUrl: endpoints.mcpUrl } : {}),
    ...(endpoints.controlUrl ? { controlUrl: endpoints.controlUrl } : {}),
    ...(manifest.localAuthToken ? { authToken: manifest.localAuthToken } : {}),
    manifest: redactRuntimeManifest(manifest),
  };
}

function manifestEndpointsMatch(manifest: RuntimeManifest): boolean {
  const endpoints = daemonEndpoints(manifest.host, manifest.port);
  if (!endpoints.mcpUrl || !endpoints.controlUrl) return false;

  return (
    (!manifest.mcpUrl || endpointMatches(manifest.mcpUrl, endpoints.mcpUrl, "/mcp")) &&
    (!manifest.controlUrl || endpointMatches(manifest.controlUrl, endpoints.controlUrl, ""))
  );
}

function endpointMatches(value: string, expected: string, expectedPath: string): boolean {
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    return (
      actual.protocol === "http:" &&
      actual.hostname === target.hostname &&
      effectivePort(actual) === effectivePort(target) &&
      actual.username === "" &&
      actual.password === "" &&
      actual.search === "" &&
      actual.hash === "" &&
      trimTrailingSlash(actual.pathname) === expectedPath
    );
  } catch {
    return false;
  }
}

function daemonEndpoints(host: string, port: number | undefined): {
  mcpUrl?: string;
  controlUrl?: string;
} {
  if (!isLoopbackHost(host) || !isValidPort(port)) return {};
  const formattedHost = formatHost(host);
  return {
    mcpUrl: `http://${formattedHost}:${port}/mcp`,
    controlUrl: `http://${formattedHost}:${port}`,
  };
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function trimTrailingSlash(pathname: string): string {
  if (pathname === "/") return "";
  return pathname.replace(/\/+$/, "");
}

async function probeHealth(
  manifest: RuntimeManifest,
  timeoutMs = 1000,
): Promise<Record<string, unknown> | null> {
  if (!manifest.localAuthToken || !manifest.port || !isLoopbackHost(manifest.host)) {
    return null;
  }

  const endpoint = manifest.controlUrl ?? `http://${formatHost(manifest.host)}:${manifest.port}`;
  let url: URL;
  try {
    url = new URL(DAEMON_HEALTH_PATH, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
      return null;
    }
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${manifest.localAuthToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  const addressType = isIP(normalizedHost);
  if (addressType === 6) return normalizedHost === "::1";
  if (addressType !== 4) return false;

  const octets = normalizedHost.split(".");
  return octets.length === 4 && octets[0] === "127";
}

function isValidPort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535;
}

export interface RuntimeInvocation {
  command: string;
  args: string[];
}

interface RuntimeCommand extends RuntimeInvocation {
  includeScript: boolean;
}

/**
 * Vitest executes this package with Node while the source entrypoint is a
 * TypeScript module. Use Bun for that source-only case; built CLI artifacts
 * continue to use the executable that launched RouterMCP. A Bun-compiled
 * executable reports a virtual `/$bunfs/...` entrypoint, which is not an
 * application script and must not be forwarded as one of the CLI arguments.
 */
function getRuntimeCommand(script: string): RuntimeCommand {
  const includeScript = !isCompiledBunEntrypoint(script);
  if (extname(script) === ".ts" && !isBunRuntime()) {
    return { command: "bun", args: [], includeScript };
  }
  return { command: process.execPath, args: [], includeScript };
}

/** Return true for the virtual entrypoint exposed by `bun --compile`. */
export function isCompiledBunEntrypoint(script: string): boolean {
  return /(?:^|[\\/])\$bunfs(?:[\\/]|$)/.test(script);
}

/** Build a runtime command while keeping bundled virtual paths out of argv. */
export function buildRuntimeInvocation(
  script: string,
  commandArgs: readonly string[],
): RuntimeInvocation {
  const runtime = getRuntimeCommand(script);
  return {
    command: runtime.command,
    args: [...runtime.args, ...(runtime.includeScript ? [script] : []), ...commandArgs],
  };
}

function isBunRuntime(): boolean {
  return typeof globalThis.Bun !== "undefined" || /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath);
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function killProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between identity check and signal delivery.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
