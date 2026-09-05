import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ConfigScope } from "../config/types.js";
import { ConnectionTracker, type ConnectionLease } from "./connection-tracker.js";
import { getDaemonHostPaths } from "./paths.js";
import { getProfileId, getProjectId } from "./project.js";

export const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_WORKSPACE_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
export const MAX_WORKSPACE_RECORDS = 256;

export type WorkspaceState = "current" | "active" | "known" | "stale" | "unavailable";
type StoredWorkspaceState = Exclude<WorkspaceState, "current">;

/** Browser-safe local-management view of one client/config workspace. */
export interface WorkspaceSnapshot {
  id: string;
  /** Visible only through the authenticated local management API. */
  directory: string;
  /** Display/diagnostic path; config contents are never part of this record. */
  configPath: string;
  configScope: ConfigScope;
  profileId: string;
  configDigest: string;
  state: WorkspaceState;
  activeConnections: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastError?: string;
}

export interface WorkspaceRegistrationInput {
  directory: string;
  configPath: string;
  configScope: ConfigScope;
  configDigest: string;
  /** Optional claims are verified against canonical paths before use. */
  workspaceId?: string;
  profileId?: string;
}

export interface WorkspaceDescriptor {
  id: string;
  directory: string;
  configPath: string;
  configScope: ConfigScope;
  profileId: string;
  configDigest: string;
}

export interface WorkspaceRegistryOptions {
  path?: string;
  retentionMs?: number;
  maxRecords?: number;
  now?: () => number;
  /** Override realpath for deterministic tests and embedders. */
  canonicalizePath?: (path: string) => Promise<string>;
}

interface StoredWorkspace extends Omit<WorkspaceSnapshot, "state"> {
  state: StoredWorkspaceState;
}

interface WorkspaceRegistryDocument {
  schemaVersion: typeof WORKSPACE_REGISTRY_SCHEMA_VERSION;
  updatedAt: string;
  workspaces: StoredWorkspace[];
}

export class WorkspaceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

/**
 * A small, atomic, user-local registry of directories that have connected to
 * the daemon host. It intentionally retains records after a bridge exits so
 * the hosted console can explain known/stale workspaces instead of making a
 * directory disappear on every client restart.
 */
export class WorkspaceRegistry {
  private readonly path: string;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly canonicalize: (path: string) => Promise<string>;
  private readonly records = new Map<string, StoredWorkspace>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.path = resolve(options.path ?? getDaemonHostPaths().workspaceRegistry);
    this.retentionMs = validateRetention(options.retentionMs ?? DEFAULT_WORKSPACE_RETENTION_MS);
    this.maxRecords = validateMaxRecords(options.maxRecords ?? MAX_WORKSPACE_RECORDS);
    this.now = options.now ?? Date.now;
    this.canonicalize = options.canonicalizePath ?? canonicalizePath;
  }

  get registryPath(): string {
    return this.path;
  }

  /** Load once; malformed state is ignored so a corrupted registry cannot
   * prevent the daemon from starting. The next mutation replaces it safely. */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  /**
   * Canonicalize and verify a lease's path/profile claims without persisting
   * or incrementing the active connection count.
   */
  async describe(input: WorkspaceRegistrationInput): Promise<WorkspaceDescriptor> {
    return createWorkspaceDescriptor(input, this.canonicalize);
  }

  /** Register one bridge connection and increment its workspace count. */
  async acquire(input: WorkspaceRegistrationInput): Promise<WorkspaceSnapshot> {
    const descriptor = await this.describe(input);
    return this.mutate(async () => {
      const timestamp = nowIso(this.now);
      const previous = this.records.get(descriptor.id);
      const record: StoredWorkspace = previous
        ? {
            ...previous,
            directory: descriptor.directory,
            configPath: descriptor.configPath,
            configScope: descriptor.configScope,
            profileId: descriptor.profileId,
            configDigest: descriptor.configDigest,
            state: "active",
            activeConnections: boundedCount(previous.activeConnections + 1),
            lastSeenAt: timestamp,
            lastError: undefined,
          }
        : {
            ...descriptor,
            state: "active",
            activeConnections: 1,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
          };

      this.records.set(record.id, record);
      this.boundRecords();
      await this.persist();
      return toSnapshot(record);
    });
  }

  /**
   * Ensure a workspace record exists without claiming a bridge lease. This is
   * used by the daemon itself for the context that launched the host; bridge
   * acquisition should use acquire() so activeConnections remains accurate.
   */
  async ensure(input: WorkspaceRegistrationInput): Promise<WorkspaceSnapshot> {
    const descriptor = await this.describe(input);
    return this.mutate(async () => {
      const timestamp = nowIso(this.now);
      const previous = this.records.get(descriptor.id);
      const record: StoredWorkspace = previous
        ? {
            ...previous,
            directory: descriptor.directory,
            configPath: descriptor.configPath,
            configScope: descriptor.configScope,
            profileId: descriptor.profileId,
            configDigest: descriptor.configDigest,
            state: previous.activeConnections > 0 ? "active" : "known",
            lastSeenAt: timestamp,
            lastError: undefined,
          }
        : {
            ...descriptor,
            state: "known",
            activeConnections: 0,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
          };

      this.records.set(record.id, record);
      this.boundRecords();
      await this.persist();
      return toSnapshot(record);
    });
  }

  /** Refresh a registered workspace without changing its active count. */
  async heartbeat(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;

    return this.mutate(async () => {
      const record = this.records.get(id);
      if (!record) return null;

      const next: StoredWorkspace = {
        ...record,
        state: record.activeConnections > 0 ? "active" : record.state,
        lastSeenAt: nowIso(this.now),
      };
      this.records.set(id, next);
      await this.persist();
      return toSnapshot(next);
    });
  }

  /** Decrement a bridge count but retain the record for future inspection. */
  async release(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;

    return this.mutate(async () => {
      const record = this.records.get(id);
      if (!record) return null;

      const activeConnections = Math.max(0, record.activeConnections - 1);
      const next: StoredWorkspace = {
        ...record,
        activeConnections,
        state: activeConnections > 0 ? "active" : "known",
        lastSeenAt: nowIso(this.now),
      };
      this.records.set(id, next);
      await this.persist();
      return toSnapshot(next);
    });
  }

  /** Mark the workspace unavailable without recording raw upstream errors. */
  async markUnavailable(workspaceId: string, error: unknown): Promise<WorkspaceSnapshot | null> {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;

    return this.mutate(async () => {
      const record = this.records.get(id);
      if (!record) return null;

      const next: StoredWorkspace = {
        ...record,
        state: "unavailable",
        lastError: sanitizeWorkspaceError(error),
        lastSeenAt: nowIso(this.now),
      };
      this.records.set(id, next);
      await this.persist();
      return toSnapshot(next);
    });
  }

  /** Forget only an inactive record; active contexts require explicit release. */
  async forget(workspaceId: string): Promise<boolean> {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return false;

    return this.mutate(async () => {
      const record = this.records.get(id);
      if (!record) return false;
      if (record.activeConnections > 0) {
        throw new WorkspaceRegistryError("Cannot forget a workspace with active connections");
      }
      this.records.delete(id);
      await this.persist();
      return true;
    });
  }

  /** List current/active/known records, pruning only beyond the retention window. */
  async list(options: { currentWorkspaceId?: string } = {}): Promise<WorkspaceSnapshot[]> {
    const currentId = normalizeWorkspaceId(options.currentWorkspaceId);
    return this.mutate(async () => {
      const changed = this.pruneExpired();
      if (changed) await this.persist();

      return Array.from(this.records.values())
        .map((record) => toSnapshot(record, record.id === currentId))
        .sort(compareWorkspaceSnapshots);
    });
  }

  async get(
    workspaceId: string,
    options: { current?: boolean } = {},
  ): Promise<WorkspaceSnapshot | null> {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;

    return this.mutate(async () => {
      const changed = this.pruneExpired();
      if (changed) await this.persist();
      const record = this.records.get(id);
      return record ? toSnapshot(record, options.current === true) : null;
    });
  }

  /**
   * Synchronous snapshot access for control-plane source callbacks. Callers
   * must await load()/ensure()/acquire() before reading this view.
   */
  listSync(options: { currentWorkspaceId?: string } = {}): WorkspaceSnapshot[] {
    const currentId = normalizeWorkspaceId(options.currentWorkspaceId);
    return Array.from(this.records.values())
      .map((record) => toSnapshot(record, record.id === currentId))
      .sort(compareWorkspaceSnapshots);
  }

  getSync(workspaceId: string, options: { current?: boolean } = {}): WorkspaceSnapshot | null {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;
    const record = this.records.get(id);
    return record ? toSnapshot(record, options.current === true) : null;
  }

  get size(): number {
    return this.records.size;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.readFromDisk();
    await this.loadPromise;
  }

  private async readFromDisk(): Promise<void> {
    try {
      const content = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isRegistryDocument(parsed)) return;
      for (const record of parsed.workspaces) {
        this.records.set(record.id, record);
      }
      this.boundRecords();
    } catch {
      // Startup must recover from a missing/corrupt local registry. A later
      // mutation publishes a fresh atomic document.
    } finally {
      this.loaded = true;
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureLoaded();
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    const document: WorkspaceRegistryDocument = {
      schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
      updatedAt: nowIso(this.now),
      workspaces: Array.from(this.records.values()).sort((left, right) => {
        return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
      }),
    };
    await writeJsonAtomic(this.path, document);
  }

  private pruneExpired(): boolean {
    const cutoff = this.now() - this.retentionMs;
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.activeConnections > 0) continue;
      if (Date.parse(record.lastSeenAt) < cutoff) {
        this.records.delete(id);
        changed = true;
      } else if (record.state === "active") {
        this.records.set(id, { ...record, state: "known" });
        changed = true;
      }
    }
    return changed;
  }

  private boundRecords(): void {
    if (this.records.size <= this.maxRecords) return;
    const ordered = Array.from(this.records.values()).sort((left, right) => {
      // Active contexts are always retained. The configured bound limits
      // inactive history; losing a live lease would make lifecycle and stop
      // safety decisions incorrect.
      if (left.activeConnections > 0 && right.activeConnections === 0) return -1;
      if (left.activeConnections === 0 && right.activeConnections > 0) return 1;
      return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
    });
    this.records.clear();
    const active = ordered.filter((record) => record.activeConnections > 0);
    const inactive = ordered
      .filter((record) => record.activeConnections === 0)
      .slice(0, Math.max(0, this.maxRecords - active.length));
    for (const record of [...active, ...inactive]) {
      this.records.set(record.id, record);
    }
  }
}

/**
 * Adapter used by the HTTP bridge. It gives the lease tracker opaque
 * workspace/profile IDs while the registry owns path/config metadata and
 * durable active counts.
 */
export class WorkspaceLeaseTracker {
  private readonly tracker: ConnectionTracker;
  private readonly pendingReleases = new Set<Promise<void>>();

  constructor(
    private readonly registry: WorkspaceRegistry,
    options: {
      idleTimeout?: number;
      leaseTtlMs?: number;
      onIdle?: () => void;
    } = {},
  ) {
    this.tracker = new ConnectionTracker(
      options.idleTimeout,
      options.onIdle,
      options.leaseTtlMs,
      (lease, reason) => {
        if (reason !== "released" && lease.workspaceId) {
          this.queueRelease(lease.workspaceId);
        }
      },
    );
  }

  async acquire(input: unknown): Promise<ConnectionLease> {
    const registration = parseWorkspaceRegistration(input);
    if (!registration) {
      throw new WorkspaceRegistryError(
        "Bridge lease acquisition requires directory, configPath, configScope, and configDigest",
      );
    }

    const descriptor = await this.registry.describe(registration);
    const workspace = await this.registry.acquire(registration);
    try {
      return this.tracker.acquire(randomUUID(), {
        workspaceId: workspace.id,
        profileId: descriptor.profileId,
      });
    } catch (error) {
      await this.registry.release(workspace.id).catch(() => undefined);
      throw error;
    }
  }

  async heartbeat(leaseId: string): Promise<ConnectionLease | null> {
    const lease = this.tracker.heartbeat(leaseId);
    if (!lease) return null;
    if (lease.workspaceId) await this.registry.heartbeat(lease.workspaceId);
    return lease;
  }

  async release(leaseId: string): Promise<void> {
    const lease = this.tracker.remove(leaseId);
    if (lease?.workspaceId) await this.registry.release(lease.workspaceId);
    await this.flushReleases();
  }

  get leases(): readonly ConnectionLease[] {
    return this.tracker.leases;
  }

  get count(): number {
    return this.tracker.count;
  }

  async destroy(): Promise<void> {
    this.tracker.destroy();
    await this.flushReleases();
  }

  private queueRelease(workspaceId: string): void {
    const operation = this.registry.release(workspaceId).then(() => undefined);
    this.pendingReleases.add(operation);
    // Keep expiry/destroy callbacks from becoming unhandled rejections while
    // retaining the original promise for an explicit flush at shutdown.
    void operation.catch(() => undefined).finally(() => {
      this.pendingReleases.delete(operation);
    });
  }

  private async flushReleases(): Promise<void> {
    while (this.pendingReleases.size > 0) {
      await Promise.all(Array.from(this.pendingReleases));
    }
  }
}

export async function createWorkspaceDescriptor(
  input: WorkspaceRegistrationInput,
  canonicalize: (path: string) => Promise<string> = canonicalizePath,
): Promise<WorkspaceDescriptor> {
  validateRegistrationInput(input);
  const directory = await canonicalize(input.directory);
  const configPath = await canonicalize(input.configPath);
  const projectId = getProjectId(directory);
  const profileId = getProfileId(projectId, configPath);
  const id = getWorkspaceId(directory, configPath);

  if (input.workspaceId !== undefined && input.workspaceId !== id) {
    throw new WorkspaceRegistryError("Bridge workspace ID does not match its canonical paths");
  }
  if (input.profileId !== undefined && input.profileId !== profileId) {
    throw new WorkspaceRegistryError("Bridge profile ID does not match its canonical paths");
  }

  return {
    id,
    directory,
    configPath,
    configScope: input.configScope,
    profileId,
    configDigest: input.configDigest,
  };
}

/** Stable, bounded identity from the client directory and resolved config. */
export function getWorkspaceId(directory: string, configPath: string): string {
  const canonicalDirectory = resolve(directory);
  const canonicalConfigPath = resolve(configPath);
  return createHash("sha256")
    .update(`${canonicalDirectory}\u0000${canonicalConfigPath}`)
    .digest("hex")
    .slice(0, 32);
}

function parseWorkspaceRegistration(input: unknown): WorkspaceRegistrationInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.directory !== "string" ||
    typeof value.configPath !== "string" ||
    typeof value.configScope !== "string" ||
    typeof value.configDigest !== "string"
  ) {
    return null;
  }
  return {
    directory: value.directory,
    configPath: value.configPath,
    configScope: value.configScope as ConfigScope,
    configDigest: value.configDigest,
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.profileId === "string" ? { profileId: value.profileId } : {}),
  };
}

function validateRegistrationInput(input: WorkspaceRegistrationInput): void {
  for (const [name, value] of [
    ["directory", input.directory],
    ["configPath", input.configPath],
    ["configDigest", input.configDigest],
  ] as const) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
      throw new WorkspaceRegistryError(`Workspace ${name} must be a non-empty bounded string`);
    }
  }
  if (!["project-local", "user-project", "user-global"].includes(input.configScope)) {
    throw new WorkspaceRegistryError("Workspace configScope is invalid");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.configDigest)) {
    throw new WorkspaceRegistryError("Workspace configDigest must be a SHA-256 hex digest");
  }
  for (const [name, value] of [
    ["workspaceId", input.workspaceId],
    ["profileId", input.profileId],
  ] as const) {
    if (value !== undefined && (value.length === 0 || value.length > 256)) {
      throw new WorkspaceRegistryError(`Workspace ${name} is invalid`);
    }
  }
}

function normalizeWorkspaceId(value: string | undefined): string | undefined {
  if (!value || value.length > 256 || !/^[a-z0-9-]+$/i.test(value)) return undefined;
  return value;
}

function toSnapshot(record: StoredWorkspace, current = false): WorkspaceSnapshot {
  return {
    ...record,
    state: current ? "current" : record.state,
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

function compareWorkspaceSnapshots(left: WorkspaceSnapshot, right: WorkspaceSnapshot): number {
  if (left.state === "current" && right.state !== "current") return -1;
  if (left.state !== "current" && right.state === "current") return 1;
  if (left.state === "active" && right.state !== "active") return -1;
  if (left.state !== "active" && right.state === "active") return 1;
  return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
}

async function canonicalizePath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch (error) {
    // A client may register just before a config/project directory is created;
    // retain the normalized absolute identity until it exists.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return resolved;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isRegistryDocument(value: unknown): value is WorkspaceRegistryDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (
    document.schemaVersion !== WORKSPACE_REGISTRY_SCHEMA_VERSION ||
    typeof document.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(document.updatedAt)) ||
    !Array.isArray(document.workspaces)
  ) {
    return false;
  }
  return document.workspaces.every(isStoredWorkspace);
}

function isStoredWorkspace(value: unknown): value is StoredWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    record.id.length <= 256 &&
    typeof record.directory === "string" &&
    record.directory.length > 0 &&
    record.directory.length <= 4_096 &&
    typeof record.configPath === "string" &&
    record.configPath.length > 0 &&
    record.configPath.length <= 4_096 &&
    (record.configScope === "project-local" ||
      record.configScope === "user-project" ||
      record.configScope === "user-global") &&
    typeof record.profileId === "string" &&
    typeof record.configDigest === "string" &&
    /^[a-f0-9]{64}$/i.test(record.configDigest) &&
    (record.state === "active" ||
      record.state === "known" ||
      record.state === "stale" ||
      record.state === "unavailable") &&
    typeof record.activeConnections === "number" &&
    Number.isSafeInteger(record.activeConnections) &&
    record.activeConnections >= 0 &&
    typeof record.firstSeenAt === "string" &&
    Number.isFinite(Date.parse(record.firstSeenAt)) &&
    typeof record.lastSeenAt === "string" &&
    Number.isFinite(Date.parse(record.lastSeenAt)) &&
    (record.lastError === undefined || typeof record.lastError === "string")
  );
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function boundedCount(value: number): number {
  return Math.min(Math.max(Math.floor(value), 0), Number.MAX_SAFE_INTEGER);
}

function validateRetention(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WORKSPACE_RETENTION_MS) {
    throw new RangeError(
      `Workspace retention must be a positive integer no greater than ${MAX_WORKSPACE_RETENTION_MS}ms`,
    );
  }
  return value;
}

function validateMaxRecords(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WORKSPACE_RECORDS) {
    throw new RangeError(
      `Workspace registry maxRecords must be a positive integer no greater than ${MAX_WORKSPACE_RECORDS}`,
    );
  }
  return value;
}

function sanitizeWorkspaceError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/[\u0000-\u001f\u007f]/g, " ");
  message = message.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  message = message.replace(
    /([?&](?:token|access_token|refresh_token|api[_-]?key|key|secret|password)=)[^&\s]+/gi,
    "$1[redacted]",
  );
  return message.slice(0, 2_000);
}
