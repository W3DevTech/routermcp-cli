import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { VERSION } from "../version.js";
import { DAEMON_PROTOCOL_VERSION } from "./runtime-manifest.js";
import { captureProcessIdentity, type ProcessIdentity } from "./identity.js";
import {
  type DaemonReadinessState,
  type ReadinessError,
  createReadinessSnapshot,
  isReadinessState,
} from "./readiness.js";

/** Version the host manifest independently from legacy profile manifests. */
export const DAEMON_HOST_MANIFEST_SCHEMA_VERSION = 1 as const;
/** Protocol spoken by the user-scoped host lifecycle and control plane. */
export const DAEMON_HOST_MANIFEST_PROTOCOL_VERSION = "1";
/** Version of the host capability set, independent from MCP protocol dates. */
export const DAEMON_HOST_CAPABILITY_VERSION = 1 as const;
/** Capabilities required by the current multi-workspace host implementation. */
export const DAEMON_HOST_CAPABILITIES = [
  "workspace-routing",
  "workspace-management",
  "workspace-activation",
] as const;
export type DaemonHostCapability = (typeof DAEMON_HOST_CAPABILITIES)[number];
export const DAEMON_HOST_DEFAULT = "127.0.0.1";

/**
 * Process/endpoint identity for the one user-scoped daemon host.
 *
 * Workspace-specific config and status intentionally do not live in this
 * manifest. They belong in the local workspace registry so one host can own
 * more than one context without replacing the process identity on every
 * directory change.
 */
export interface DaemonHostManifest {
  schemaVersion: typeof DAEMON_HOST_MANIFEST_SCHEMA_VERSION;
  kind: "daemon-host";
  hostId: string;
  instanceId: string;
  pid: number;
  processIdentity: ProcessIdentity;
  cliVersion: string;
  protocolVersion: string;
  /** Host lifecycle protocol; absent only in manifests from before negotiation. */
  hostProtocolVersion?: string;
  /** Host capability set; absent only in manifests from before negotiation. */
  hostCapabilityVersion?: number;
  hostCapabilities?: readonly string[];
  host: string;
  port?: number;
  socketPath?: string;
  mcpUrl?: string;
  controlUrl?: string;
  /** Primary context used when this host was first started. */
  primaryProjectPath?: string;
  primaryConfigPath?: string;
  primaryProfileId?: string;
  primaryConfigFingerprint?: string;
  state: DaemonReadinessState;
  startedAt: string;
  updatedAt: string;
  readyAt?: string;
  failedAt?: string;
  stoppingAt?: string;
  error?: ReadinessError;
  /** Private loopback credential; never include it in public snapshots. */
  localAuthToken?: string;
}

export type PublicDaemonHostManifest = Omit<DaemonHostManifest, "localAuthToken">;

export interface CreateDaemonHostManifestOptions {
  hostId: string;
  pid?: number;
  processIdentity?: ProcessIdentity;
  cliVersion?: string;
  protocolVersion?: string;
  hostProtocolVersion?: string;
  hostCapabilityVersion?: number;
  hostCapabilities?: readonly string[];
  host?: string;
  port?: number;
  socketPath?: string;
  mcpUrl?: string;
  controlUrl?: string;
  primaryProjectPath?: string;
  primaryConfigPath?: string;
  primaryProfileId?: string;
  primaryConfigFingerprint?: string;
  state?: DaemonReadinessState;
  error?: ReadinessError;
  localAuthToken?: string;
  now?: Date;
  instanceId?: string;
}

export async function createDaemonHostManifest(
  options: CreateDaemonHostManifestOptions,
): Promise<DaemonHostManifest> {
  const pid = options.pid ?? process.pid;
  const processIdentity =
    options.processIdentity ??
    (await captureProcessIdentity(pid)) ?? {
      pid,
      source: "pid" as const,
    };
  const readiness = createReadinessSnapshot(options.state ?? "starting", options.now);

  return {
    schemaVersion: DAEMON_HOST_MANIFEST_SCHEMA_VERSION,
    kind: "daemon-host",
    hostId: options.hostId,
    instanceId: options.instanceId ?? randomUUID(),
    pid,
    processIdentity,
    cliVersion: options.cliVersion ?? VERSION,
    protocolVersion: options.protocolVersion ?? DAEMON_HOST_MANIFEST_PROTOCOL_VERSION,
    hostProtocolVersion: options.hostProtocolVersion ?? DAEMON_HOST_MANIFEST_PROTOCOL_VERSION,
    hostCapabilityVersion: options.hostCapabilityVersion ?? DAEMON_HOST_CAPABILITY_VERSION,
    hostCapabilities: options.hostCapabilities ?? DAEMON_HOST_CAPABILITIES,
    host: options.host ?? DAEMON_HOST_DEFAULT,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.mcpUrl === undefined ? {} : { mcpUrl: options.mcpUrl }),
    ...(options.controlUrl === undefined ? {} : { controlUrl: options.controlUrl }),
    ...(options.primaryProjectPath === undefined
      ? {}
      : { primaryProjectPath: options.primaryProjectPath }),
    ...(options.primaryConfigPath === undefined
      ? {}
      : { primaryConfigPath: options.primaryConfigPath }),
    ...(options.primaryProfileId === undefined
      ? {}
      : { primaryProfileId: options.primaryProfileId }),
    ...(options.primaryConfigFingerprint === undefined
      ? {}
      : { primaryConfigFingerprint: options.primaryConfigFingerprint }),
    ...readiness,
    ...(options.state === "failed" && options.error ? { error: options.error } : {}),
    ...(options.localAuthToken === undefined ? {} : { localAuthToken: options.localAuthToken }),
  };
}

/** Atomically publish a private host manifest beside the destination. */
export async function writeDaemonHostManifest(
  manifestPath: string,
  manifest: DaemonHostManifest,
): Promise<void> {
  const serialized = serializeDaemonHostManifest(manifest);
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
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export const writeDaemonHostManifestAtomic = writeDaemonHostManifest;

/** Return null for missing, malformed, or incompatible host state. */
export async function readDaemonHostManifest(
  manifestPath: string,
): Promise<DaemonHostManifest | null> {
  let content: string;
  try {
    content = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  try {
    const value: unknown = JSON.parse(content);
    return isDaemonHostManifest(value) ? value : null;
  } catch {
    return null;
  }
}

export async function removeDaemonHostManifest(manifestPath: string): Promise<void> {
  await unlink(manifestPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export function redactDaemonHostManifest(
  manifest: DaemonHostManifest,
): PublicDaemonHostManifest {
  const { localAuthToken: _localAuthToken, ...publicManifest } = manifest;
  return publicManifest;
}

export function serializeDaemonHostManifest(manifest: DaemonHostManifest): string {
  if (!isDaemonHostManifest(manifest)) {
    throw new Error("Cannot serialize an invalid RouterMCP daemon host manifest");
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface DaemonHostCompatibility {
  compatible: boolean;
  reason?: string;
}

/**
 * Check whether this CLI can safely reuse a persisted daemon host.
 *
 * `protocolVersion` describes the runtime wire protocol. The host-specific
 * protocol and capability version are separate because a host can keep the
 * MCP protocol stable while changing workspace routing or management
 * semantics. Older manifests intentionally remain readable so their process
 * identity can be checked and safely retired instead of being mistaken for a
 * missing host.
 */
export function getDaemonHostCompatibility(
  manifest: DaemonHostManifest,
  options: {
    cliVersion?: string;
    protocolVersion?: string;
    hostProtocolVersion?: string;
    hostCapabilityVersion?: number;
    requiredCapabilities?: readonly string[];
  } = {},
): DaemonHostCompatibility {
  const cliVersion = options.cliVersion ?? VERSION;
  if (manifest.cliVersion !== cliVersion) {
    return {
      compatible: false,
      reason: `Daemon host CLI version mismatch (running ${manifest.cliVersion}, current ${cliVersion})`,
    };
  }

  const protocolVersion = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION;
  if (manifest.protocolVersion !== protocolVersion) {
    return {
      compatible: false,
      reason: `Daemon host runtime protocol mismatch (running ${manifest.protocolVersion}, current ${protocolVersion})`,
    };
  }

  const hostProtocolVersion =
    options.hostProtocolVersion ?? DAEMON_HOST_MANIFEST_PROTOCOL_VERSION;
  if (manifest.hostProtocolVersion !== hostProtocolVersion) {
    return {
      compatible: false,
      reason: `Daemon host protocol mismatch (running ${manifest.hostProtocolVersion ?? "unknown"}, current ${hostProtocolVersion})`,
    };
  }

  const hostCapabilityVersion = options.hostCapabilityVersion ?? DAEMON_HOST_CAPABILITY_VERSION;
  if (manifest.hostCapabilityVersion !== hostCapabilityVersion) {
    return {
      compatible: false,
      reason: `Daemon host capability version mismatch (running ${manifest.hostCapabilityVersion ?? "unknown"}, current ${hostCapabilityVersion})`,
    };
  }

  const requiredCapabilities = options.requiredCapabilities ?? DAEMON_HOST_CAPABILITIES;
  if (!hasDaemonHostCapabilities(manifest.hostCapabilities, requiredCapabilities)) {
    return {
      compatible: false,
      reason: "Daemon host does not advertise the required capabilities",
    };
  }

  return { compatible: true };
}

/** Return whether a host advertises every capability required by this CLI. */
export function hasDaemonHostCapabilities(
  capabilities: readonly string[] | undefined,
  required: readonly string[] = DAEMON_HOST_CAPABILITIES,
): boolean {
  if (!capabilities) return false;
  const available = new Set(capabilities);
  return required.every((capability) => available.has(capability));
}

export function isDaemonHostManifest(value: unknown): value is DaemonHostManifest {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== DAEMON_HOST_MANIFEST_SCHEMA_VERSION ||
    value.kind !== "daemon-host" ||
    !isNonEmptyString(value.hostId) ||
    !isNonEmptyString(value.instanceId) ||
    !isValidPid(value.pid) ||
    !isProcessIdentity(value.processIdentity) ||
    value.processIdentity.pid !== value.pid ||
    !isNonEmptyString(value.cliVersion) ||
    !isNonEmptyString(value.protocolVersion) ||
    !isNonEmptyString(value.host) ||
    !isReadinessState(value.state) ||
    !isIsoTimestamp(value.startedAt) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return false;
  }

  if (value.port !== undefined && !isPort(value.port)) return false;
  if (value.hostProtocolVersion !== undefined && !isNonEmptyString(value.hostProtocolVersion)) {
    return false;
  }
  if (
    value.hostCapabilityVersion !== undefined &&
    (typeof value.hostCapabilityVersion !== "number" ||
      !Number.isSafeInteger(value.hostCapabilityVersion) ||
      value.hostCapabilityVersion < 1)
  ) {
    return false;
  }
  if (
    value.hostCapabilities !== undefined &&
    (!Array.isArray(value.hostCapabilities) ||
      value.hostCapabilities.some((capability) => !isNonEmptyString(capability)))
  ) {
    return false;
  }
  for (const key of [
    "socketPath",
    "mcpUrl",
    "controlUrl",
    "localAuthToken",
    "primaryProjectPath",
    "primaryConfigPath",
    "primaryProfileId",
    "primaryConfigFingerprint",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    typeof value.primaryConfigFingerprint === "string" &&
    !/^[a-f0-9]{64}$/i.test(value.primaryConfigFingerprint)
  ) {
    return false;
  }
  for (const key of ["readyAt", "failedAt", "stoppingAt"] as const) {
    if (value[key] !== undefined && !isIsoTimestamp(value[key])) return false;
  }
  return value.error === undefined || isReadinessError(value.error);
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
  if (!isRecord(value) || !isValidPid(value.pid)) return false;
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
