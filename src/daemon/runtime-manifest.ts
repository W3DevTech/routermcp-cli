import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { VERSION } from "../version.js";
import { captureProcessIdentity, type ProcessIdentity } from "./identity.js";
import {
  type DaemonReadinessState,
  type ReadinessError,
  createReadinessSnapshot,
  isReadinessState,
} from "./readiness.js";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;
export const DAEMON_PROTOCOL_VERSION = "1";
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

export interface RuntimeManifest {
  schemaVersion: typeof RUNTIME_MANIFEST_SCHEMA_VERSION;
  instanceId: string;
  projectId: string;
  profileId: string;
  pid: number;
  processIdentity: ProcessIdentity;
  cliVersion: string;
  protocolVersion: string;
  configPath: string;
  configFingerprint: string;
  host: string;
  port?: number;
  socketPath?: string;
  mcpUrl?: string;
  controlUrl?: string;
  state: DaemonReadinessState;
  startedAt: string;
  updatedAt: string;
  readyAt?: string;
  failedAt?: string;
  stoppingAt?: string;
  error?: ReadinessError;
  /**
   * Private bearer material used by the loopback control plane. This field is
   * only written to the 0600 manifest and must be removed before exposing the
   * manifest to a UI or log.
   */
  localAuthToken?: string;
}

export type PublicRuntimeManifest = Omit<RuntimeManifest, "localAuthToken">;

export interface CreateRuntimeManifestOptions {
  projectId: string;
  profileId: string;
  configPath: string;
  configFingerprint: string;
  pid?: number;
  processIdentity?: ProcessIdentity;
  cliVersion?: string;
  protocolVersion?: string;
  host?: string;
  port?: number;
  socketPath?: string;
  mcpUrl?: string;
  controlUrl?: string;
  state?: DaemonReadinessState;
  error?: ReadinessError;
  localAuthToken?: string;
  now?: Date;
  instanceId?: string;
}

/**
 * Create a manifest with a fresh instance id and a process identity captured
 * at creation time. The instance id distinguishes a restarted daemon even if
 * the operating system reuses its PID.
 */
export async function createRuntimeManifest(
  options: CreateRuntimeManifestOptions,
): Promise<RuntimeManifest> {
  const pid = options.pid ?? process.pid;
  const processIdentity =
    options.processIdentity ??
    (await captureProcessIdentity(pid)) ?? {
      pid,
      source: "pid" as const,
    };
  const readiness = createReadinessSnapshot(options.state ?? "starting", options.now);

  return {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    instanceId: options.instanceId ?? randomUUID(),
    projectId: options.projectId,
    profileId: options.profileId,
    pid,
    processIdentity,
    cliVersion: options.cliVersion ?? VERSION,
    protocolVersion: options.protocolVersion ?? DAEMON_PROTOCOL_VERSION,
    configPath: options.configPath,
    configFingerprint: options.configFingerprint,
    host: options.host ?? DEFAULT_DAEMON_HOST,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.mcpUrl === undefined ? {} : { mcpUrl: options.mcpUrl }),
    ...(options.controlUrl === undefined ? {} : { controlUrl: options.controlUrl }),
    ...readiness,
    ...(options.state === "failed" && options.error ? { error: options.error } : {}),
    ...(options.localAuthToken === undefined ? {} : { localAuthToken: options.localAuthToken }),
  };
}

/**
 * Atomically replace a runtime manifest on disk.
 *
 * The temporary file is created beside the destination, flushed, permissioned
 * 0600, and renamed into place. A same-directory rename is atomic on the
 * supported Unix platforms and prevents readers from observing partial JSON.
 */
export async function writeRuntimeManifest(
  manifestPath: string,
  manifest: RuntimeManifest,
): Promise<void> {
  const serialized = serializeRuntimeManifest(manifest);
  const directory = dirname(manifestPath);
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, manifestPath);
    await chmod(manifestPath, 0o600);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Alias emphasizing the replacement semantics for lifecycle callers. */
export const writeRuntimeManifestAtomic = writeRuntimeManifest;

/**
 * Read and validate a manifest. Missing, malformed, or incompatible state is
 * represented as null so callers can treat it as stale state and recover.
 */
export async function readRuntimeManifest(manifestPath: string): Promise<RuntimeManifest | null> {
  let content: string;
  try {
    content = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  try {
    const value: unknown = JSON.parse(content);
    return isRuntimeManifest(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remove a runtime manifest, ignoring an already-clean state. */
export async function removeRuntimeManifest(manifestPath: string): Promise<void> {
  await unlink(manifestPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

/**
 * Return a copy safe to send to logs, status commands, or hosted UI clients.
 */
export function redactRuntimeManifest(manifest: RuntimeManifest): PublicRuntimeManifest {
  const { localAuthToken: _localAuthToken, ...publicManifest } = manifest;
  return publicManifest;
}

export function serializeRuntimeManifest(manifest: RuntimeManifest): string {
  if (!isRuntimeManifest(manifest)) {
    throw new Error("Cannot serialize an invalid RouterMCP runtime manifest");
  }

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION ||
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.projectId) ||
    !isNonEmptyString(value.profileId) ||
    !isValidPid(value.pid) ||
    !isProcessIdentity(value.processIdentity) ||
    value.processIdentity.pid !== value.pid ||
    !isNonEmptyString(value.cliVersion) ||
    !isNonEmptyString(value.protocolVersion) ||
    !isNonEmptyString(value.configPath) ||
    !isNonEmptyString(value.configFingerprint) ||
    !isNonEmptyString(value.host) ||
    !isReadinessState(value.state) ||
    !isIsoTimestamp(value.startedAt) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return false;
  }

  if (value.port !== undefined && !isPort(value.port)) {
    return false;
  }

  for (const key of ["socketPath", "mcpUrl", "controlUrl", "localAuthToken"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return false;
    }
  }

  for (const key of ["readyAt", "failedAt", "stoppingAt"] as const) {
    if (value[key] !== undefined && !isIsoTimestamp(value[key])) {
      return false;
    }
  }

  if (value.error !== undefined && !isReadinessError(value.error)) {
    return false;
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value) || !isValidPid(value.pid)) {
    return false;
  }

  if (value.source !== "procfs" && value.source !== "ps" && value.source !== "pid") {
    return false;
  }

  return value.startToken === undefined || typeof value.startToken === "string";
}

function isReadinessError(value: unknown): value is ReadinessError {
  if (!isRecord(value) || typeof value.message !== "string" || value.message.length === 0) {
    return false;
  }

  return value.code === undefined || typeof value.code === "string";
}
