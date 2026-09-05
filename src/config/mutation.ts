import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { parseConfigContent } from "./loader.js";
import type { ConfigScope, RouterMcpConfig } from "./types.js";

/** The execution modes exposed by the hosted local management console. */
export const CONTROL_PLANE_EXECUTION_MODES = ["standard", "code", "tool-search"] as const;
export type ControlPlaneExecutionMode = (typeof CONTROL_PLANE_EXECUTION_MODES)[number];

/** Keep this bound in sync with CodeModeConfigSchema. */
export const CODE_MODE_TIMEOUT_MIN_MS = 1_000;
export const CODE_MODE_TIMEOUT_MAX_MS = 120_000;

const DEFAULT_CODE_MODE_TIMEOUT_MS = 30_000;
const DEFAULT_CODE_MODE_ALLOW_FETCH = true;
const DEFAULT_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_STALE_AFTER_MS = 30_000;
const MAX_MANAGEMENT_BODY_BYTES = 64 * 1024;

export type ConfigMutationErrorCode =
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "locked"
  | "invalid-config"
  | "io-error";

/**
 * A sanitized error suitable for mapping to a control-plane HTTP response.
 * Error messages intentionally contain paths and field names only; callers
 * must never put loaded config values in this error.
 */
export class ConfigMutationError extends Error {
  readonly status: number;
  readonly code: ConfigMutationErrorCode;
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    message: string,
    code: ConfigMutationErrorCode,
    options: {
      status?: number;
      details?: Record<string, string | number | boolean>;
      cause?: Error;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ConfigMutationError";
    this.code = code;
    this.status = options.status ?? statusForMutationError(code);
    this.details = options.details;
  }
}

/** An If-Match conflict; currentDigest is safe to return to local UI clients. */
export class ConfigRevisionConflictError extends ConfigMutationError {
  readonly currentDigest: string;

  constructor(currentDigest: string) {
    super("Configuration changed since this view was loaded", "conflict", {
      status: 409,
      details: { currentDigest },
    });
    this.name = "ConfigRevisionConflictError";
    this.currentDigest = currentDigest;
  }
}

export type ConfigServerKind = "mcp" | "openapi";

/** Server IDs are prefixed so mcpServers and openApiServers cannot collide. */
export interface ConfigServerReference {
  kind: ConfigServerKind;
  name: string;
}

export interface ServerEnabledPatch {
  enabled: boolean;
}

/** Validate a server availability PATCH body before touching disk. */
export function parseServerEnabledPatch(value: unknown): ServerEnabledPatch {
  if (!isRecord(value)) {
    throw new ConfigMutationError("Request body must be a JSON object", "invalid-request");
  }
  if (Object.keys(value).some((key) => key !== "enabled")) {
    throw new ConfigMutationError(
      "Server availability request contains an unsupported field",
      "invalid-request",
    );
  }
  if (typeof value.enabled !== "boolean") {
    throw new ConfigMutationError("enabled must be a boolean", "invalid-request");
  }
  return { enabled: value.enabled };
}

export interface ConfigFileSnapshot {
  path: string;
  scope?: ConfigScope;
  digest: string;
  config: RouterMcpConfig;
}

export interface ConfigMutationResult {
  changed: boolean;
  mutationId: string;
  previousConfigDigest: string;
  configDigest: string;
  previousEnabled?: boolean;
  previousMode?: ControlPlaneExecutionMode;
  /** Parsed only for the in-process context adapter; never serialize directly. */
  config: RouterMcpConfig;
}

export interface SetServerEnabledOptions {
  configPath: string;
  expectedDigest: string;
  serverId: string;
  enabled: boolean;
  lockTimeoutMs?: number;
}

export interface ExecutionModePatch {
  mode: ControlPlaneExecutionMode;
  codeMode?: {
    timeout?: number;
    allowFetch?: boolean;
  };
}

export interface SetExecutionModeOptions {
  configPath: string;
  expectedDigest: string;
  patch: ExecutionModePatch;
  lockTimeoutMs?: number;
}

/**
 * Read and validate the exact source used by a daemon context.
 *
 * The digest covers source bytes, including comments and whitespace, so an
 * edit made outside RouterMCP cannot be silently overwritten by a browser
 * mutation.
 */
export async function readConfigSnapshot(configPath: string): Promise<ConfigFileSnapshot> {
  const path = resolveConfigPath(configPath);
  const source = await readConfigSource(path);
  return {
    path,
    digest: digestConfigSource(source),
    config: parseConfigContent(source, path),
  };
}

/** SHA-256 over source bytes, matching daemon fingerprintConfigFile. */
export function digestConfigSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Parse the explicit server ID used by PATCH /api/v1/servers/:serverId. */
export function parseConfigServerId(serverId: string): ConfigServerReference {
  const separator = serverId.indexOf(":");
  const prefix = separator >= 0 ? serverId.slice(0, separator) : "";
  const name = separator >= 0 ? serverId.slice(separator + 1) : "";

  if ((prefix !== "mcp" && prefix !== "openapi") || name.length === 0) {
    throw new ConfigMutationError(
      'Server ID must use the "mcp:<name>" or "openapi:<name>" format',
      "invalid-request",
    );
  }

  return { kind: prefix, name };
}

/** Validate an execution-mode PATCH body before touching disk. */
export function parseExecutionModePatch(value: unknown): ExecutionModePatch {
  if (!isRecord(value)) {
    throw new ConfigMutationError("Request body must be a JSON object", "invalid-request");
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== "mode" && key !== "codeMode")) {
    throw new ConfigMutationError(
      "Execution mode request contains an unsupported field",
      "invalid-request",
    );
  }

  const mode = value.mode;
  if (
    mode !== "standard" &&
    mode !== "code" &&
    mode !== "tool-search"
  ) {
    throw new ConfigMutationError(
      'Execution mode must be "standard", "code", or "tool-search"',
      "invalid-request",
    );
  }

  let codeMode: ExecutionModePatch["codeMode"];
  if (value.codeMode !== undefined) {
    if (!isRecord(value.codeMode)) {
      throw new ConfigMutationError("codeMode must be a JSON object", "invalid-request");
    }

    if (mode !== "code") {
      throw new ConfigMutationError(
        "codeMode settings can only be changed when mode is code",
        "invalid-request",
      );
    }

    const codeModeKeys = Object.keys(value.codeMode);
    if (codeModeKeys.some((key) => key !== "timeout" && key !== "allowFetch")) {
      throw new ConfigMutationError(
        "codeMode contains an unsupported field",
        "invalid-request",
      );
    }

    const timeout = value.codeMode.timeout;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" ||
        !Number.isSafeInteger(timeout) ||
        timeout < CODE_MODE_TIMEOUT_MIN_MS ||
        timeout > CODE_MODE_TIMEOUT_MAX_MS)
    ) {
      throw new ConfigMutationError(
        `codeMode.timeout must be an integer between ${CODE_MODE_TIMEOUT_MIN_MS} and ${CODE_MODE_TIMEOUT_MAX_MS}`,
        "invalid-request",
      );
    }

    const allowFetch = value.codeMode.allowFetch;
    if (allowFetch !== undefined && typeof allowFetch !== "boolean") {
      throw new ConfigMutationError("codeMode.allowFetch must be a boolean", "invalid-request");
    }

    codeMode = {
      ...(timeout === undefined ? {} : { timeout }),
      ...(allowFetch === undefined ? {} : { allowFetch }),
    };
  }

  return {
    mode,
    ...(codeMode === undefined ? {} : { codeMode }),
  };
}

/** Return the effective mode represented by a validated RouterMCP config. */
export function getExecutionMode(config: RouterMcpConfig): ControlPlaneExecutionMode {
  if (config.codeMode?.enabled === true) return "code";
  if (config.mcpToolSearch?.enabled === true) return "tool-search";
  return "standard";
}

export interface ExecutionModeSnapshot {
  mode: ControlPlaneExecutionMode;
  codeMode: {
    timeout: number;
    allowFetch: boolean;
  };
  configDigest: string;
}

/** Build a browser-safe execution-mode snapshot from a file snapshot. */
export function createExecutionModeSnapshot(snapshot: ConfigFileSnapshot): ExecutionModeSnapshot {
  return {
    mode: getExecutionMode(snapshot.config),
    codeMode: {
      timeout: snapshot.config.codeMode?.timeout ?? DEFAULT_CODE_MODE_TIMEOUT_MS,
      allowFetch: snapshot.config.codeMode?.allowFetch ?? DEFAULT_CODE_MODE_ALLOW_FETCH,
    },
    configDigest: snapshot.digest,
  };
}

/** Persist a server availability toggle while preserving JSONC source style. */
export async function setServerEnabled(
  options: SetServerEnabledOptions,
): Promise<ConfigMutationResult> {
  if (typeof options.enabled !== "boolean") {
    throw new ConfigMutationError("enabled must be a boolean", "invalid-request");
  }

  const reference = parseConfigServerId(options.serverId);
  return mutateConfigFile(options.configPath, options.expectedDigest, options.lockTimeoutMs, (current) => {
    const configured = getConfiguredServer(current.config, reference);
    if (!configured) {
      throw new ConfigMutationError(
        `Configured server not found: ${options.serverId}`,
        "not-found",
      );
    }

    const currentEnabled = configured.enabled !== false;
    if (currentEnabled === options.enabled) {
      return { source: current.source, changed: false, previousEnabled: currentEnabled };
    }

    return {
      source: applyJsoncValue(
        current.source,
        [reference.kind === "mcp" ? "mcpServers" : "openApiServers", reference.name, "enabled"],
        options.enabled,
      ),
      changed: true,
      previousEnabled: currentEnabled,
    };
  });
}

/** Persist a mode change while preserving JSONC source style. */
export async function setExecutionMode(
  options: SetExecutionModeOptions,
): Promise<ConfigMutationResult> {
  const patch = parseExecutionModePatch(options.patch);
  return mutateConfigFile(options.configPath, options.expectedDigest, options.lockTimeoutMs, (current) => {
    const currentMode = getExecutionMode(current.config);
    const currentTimeout = current.config.codeMode?.timeout ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
    const currentAllowFetch = current.config.codeMode?.allowFetch ?? DEFAULT_CODE_MODE_ALLOW_FETCH;
    const requestedTimeout = patch.codeMode?.timeout ?? currentTimeout;
    const requestedAllowFetch = patch.codeMode?.allowFetch ?? currentAllowFetch;

    const sameMode = currentMode === patch.mode;
    const sameCodeSettings =
      patch.mode !== "code" ||
      (currentTimeout === requestedTimeout && currentAllowFetch === requestedAllowFetch);
    if (sameMode && sameCodeSettings) {
      return { source: current.source, changed: false, previousMode: currentMode };
    }

    let source = current.source;
    source = applyJsoncValue(source, ["codeMode", "enabled"], patch.mode === "code");
    source = applyJsoncValue(
      source,
      ["mcpToolSearch", "enabled"],
      patch.mode === "tool-search",
    );

    if (patch.mode === "code" && patch.codeMode) {
      if (patch.codeMode.timeout !== undefined) {
        source = applyJsoncValue(source, ["codeMode", "timeout"], patch.codeMode.timeout);
      }
      if (patch.codeMode.allowFetch !== undefined) {
        source = applyJsoncValue(
          source,
          ["codeMode", "allowFetch"],
          patch.codeMode.allowFetch,
        );
      }
    }

    return { source, changed: true, previousMode: currentMode };
  });
}

interface CurrentConfigSource {
  path: string;
  source: string;
  digest: string;
  config: RouterMcpConfig;
}

interface MutationEdit {
  source: string;
  changed: boolean;
  previousEnabled?: boolean;
  previousMode?: ControlPlaneExecutionMode;
}

async function mutateConfigFile(
  configPath: string,
  expectedDigest: string,
  lockTimeoutMs: number | undefined,
  edit: (current: CurrentConfigSource) => MutationEdit,
): Promise<ConfigMutationResult> {
  const path = resolveConfigPath(configPath);
  validateExpectedDigest(expectedDigest);

  return withConfigMutationLock(path, lockTimeoutMs ?? DEFAULT_CONFIG_LOCK_TIMEOUT_MS, async () => {
    const current = await readCurrentConfig(path);
    if (current.digest !== expectedDigest) {
      throw new ConfigRevisionConflictError(current.digest);
    }

    const next = edit(current);
    if (!next.changed) {
      return {
        changed: false,
        mutationId: randomUUID(),
        previousConfigDigest: current.digest,
        configDigest: current.digest,
        ...(next.previousEnabled === undefined
          ? {}
          : { previousEnabled: next.previousEnabled }),
        ...(next.previousMode === undefined ? {} : { previousMode: next.previousMode }),
        config: current.config,
      };
    }

    let validatedConfig: RouterMcpConfig;
    try {
      // Validate the complete result before opening the destination for
      // replacement. This also performs env expansion without exposing it.
      validatedConfig = parseConfigContent(next.source, path);
    } catch (error) {
      if (error instanceof ConfigMutationError) throw error;
      throw new ConfigMutationError(
        "The requested configuration change would produce an invalid config",
        "invalid-config",
        { status: 422, cause: error instanceof Error ? error : undefined },
      );
    }

    await writeConfigAtomically(path, next.source);
    const writtenSource = await readConfigSource(path);
    const writtenDigest = digestConfigSource(writtenSource);
    if (writtenDigest !== digestConfigSource(next.source)) {
      throw new ConfigMutationError(
        "Configuration changed while the mutation was being published",
        "conflict",
        { status: 409, details: { currentDigest: writtenDigest } },
      );
    }

    return {
      changed: true,
      mutationId: randomUUID(),
      previousConfigDigest: current.digest,
      configDigest: writtenDigest,
      ...(next.previousEnabled === undefined
        ? {}
        : { previousEnabled: next.previousEnabled }),
      ...(next.previousMode === undefined ? {} : { previousMode: next.previousMode }),
      config: validatedConfig,
    };
  });
}

async function readCurrentConfig(path: string): Promise<CurrentConfigSource> {
  const source = await readConfigSource(path);
  let config: RouterMcpConfig;
  try {
    config = parseConfigContent(source, path);
  } catch (error) {
    throw new ConfigMutationError(
      "The current configuration is invalid and cannot be changed",
      "invalid-config",
      { status: 422, cause: error instanceof Error ? error : undefined },
    );
  }

  return { path, source, digest: digestConfigSource(source), config };
}

async function readConfigSource(path: string): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new ConfigMutationError(
        "Refusing to mutate a symbolic-link configuration path",
        "invalid-request",
      );
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof ConfigMutationError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigMutationError(
      code === "ENOENT" ? "Configuration file not found" : "Unable to read configuration file",
      code === "ENOENT" ? "not-found" : "io-error",
      { status: code === "ENOENT" ? 404 : 500, cause: error instanceof Error ? error : undefined },
    );
  }
}

function resolveConfigPath(configPath: string): string {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new ConfigMutationError("Configuration path is required", "invalid-request");
  }
  return resolve(configPath);
}

function validateExpectedDigest(expectedDigest: string): void {
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest)) {
    throw new ConfigMutationError(
      "If-Match must contain the current 64-character configuration digest",
      "invalid-request",
      { status: 428 },
    );
  }
}

function getConfiguredServer(
  config: RouterMcpConfig,
  reference: ConfigServerReference,
): { enabled?: boolean } | undefined {
  if (reference.kind === "mcp") {
    return config.mcpServers?.[reference.name];
  }
  return config.openApiServers?.[reference.name];
}

function applyJsoncValue(source: string, path: string[], value: unknown): string {
  try {
    const edits = modify(source, path, value, {
      formattingOptions: {
        insertSpaces: detectIndentUsesSpaces(source),
        tabSize: detectIndentSize(source),
        eol: source.includes("\r\n") ? "\r\n" : "\n",
      },
    });
    return applyEdits(source, edits);
  } catch (error) {
    throw new ConfigMutationError(
      "Unable to apply a JSONC configuration edit",
      "invalid-config",
      { status: 422, cause: error instanceof Error ? error : undefined },
    );
  }
}

function detectIndentUsesSpaces(source: string): boolean {
  const match = source.match(/^[ \t]+(?=["}])/m);
  return match ? !match[0].includes("\t") : true;
}

function detectIndentSize(source: string): number {
  const match = source.match(/^( +)(?=["}])/m);
  return match ? Math.min(Math.max(match[1].length, 1), 8) : 2;
}

async function writeConfigAtomically(path: string, source: string): Promise<void> {
  let fileMode = 0o600;
  try {
    const metadata = await stat(path);
    const requestedMode = metadata.mode & 0o777;
    if (requestedMode !== 0) fileMode = requestedMode;
  } catch (error) {
    throw new ConfigMutationError("Unable to inspect configuration permissions", "io-error", {
      status: 500,
      cause: error instanceof Error ? error : undefined,
    });
  }

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", fileMode);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, fileMode);
    await rename(temporaryPath, path);
    await chmod(path, fileMode);

    // Persist the directory entry where supported. Linux allows fsync on a
    // directory; a few filesystems reject it, in which case the file's fsync
    // plus atomic same-directory rename still provides the required guarantee.
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync().catch(() => undefined);
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new ConfigMutationError("Unable to publish configuration change", "io-error", {
      status: 500,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

const mutationQueues = new Map<string, Promise<void>>();

async function withConfigMutationLock<T>(
  path: string,
  timeoutMs: number,
  callback: () => Promise<T>,
): Promise<T> {
  const prior = mutationQueues.get(path) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  const tail = prior.then(() => queued);
  mutationQueues.set(path, tail);
  await prior;

  try {
    return await withFileLock(path, timeoutMs, callback);
  } finally {
    releaseQueue();
    if (mutationQueues.get(path) === tail) mutationQueues.delete(path);
  }
}

async function withFileLock<T>(path: string, timeoutMs: number, callback: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.routermcp.lock`;
  const owner = { pid: process.pid, createdAt: Date.now(), id: randomUUID() };
  const startedAt = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      const lockHandle = await open(lockPath, "wx", 0o600);
      try {
        await lockHandle.writeFile(JSON.stringify(owner), "utf8");
        await lockHandle.sync();
      } finally {
        await lockHandle.close();
      }
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ConfigMutationError("Unable to acquire configuration lock", "io-error", {
          status: 500,
          cause: error instanceof Error ? error : undefined,
        });
      }

      const existingOwner = await readLockOwner(lockPath);
      const stale =
        existingOwner !== null &&
        Date.now() - existingOwner.createdAt >= CONFIG_LOCK_STALE_AFTER_MS &&
        !isProcessAlive(existingOwner.pid);
      if (stale) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new ConfigMutationError(
          "Another process is changing this configuration; retry shortly",
          "locked",
          { status: 423 },
        );
      }
      await delay(CONFIG_LOCK_RETRY_MS);
    }
  }

  try {
    return await callback();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function readLockOwner(path: string): Promise<{ pid: number; createdAt: number } | null> {
  try {
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.createdAt === "number" &&
      Number.isSafeInteger(value.createdAt)
    ) {
      return { pid: value.pid, createdAt: value.createdAt };
    }
  } catch {
    // A partially-created or malformed lock is treated as active until the
    // bounded timeout expires; deleting it could race an active writer.
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function statusForMutationError(code: ConfigMutationErrorCode): number {
  switch (code) {
    case "invalid-request":
      return 400;
    case "not-found":
      return 404;
    case "conflict":
      return 409;
    case "locked":
      return 423;
    case "invalid-config":
      return 422;
    case "io-error":
      return 500;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maximum body guard used by the control-plane request parser. */
export const MANAGEMENT_BODY_LIMIT_BYTES = MAX_MANAGEMENT_BODY_BYTES;

/** Parse a small JSON request body without accepting unbounded browser input. */
export async function parseManagementJsonBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_MANAGEMENT_BODY_BYTES) {
    throw new ConfigMutationError("Request body is too large", "invalid-request", { status: 413 });
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new ConfigMutationError("Request body must contain valid JSON", "invalid-request", {
      status: 400,
      cause: error instanceof Error ? error : undefined,
    });
  }
}
