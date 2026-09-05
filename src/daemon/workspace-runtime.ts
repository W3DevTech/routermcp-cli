import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { RouterMcpConfig } from "../config/types.js";
import {
  createRuntimeExecutionContext,
  type RuntimeExecutionContext,
  type RuntimeExecutionContextInput,
} from "../core/execution-context.js";
import { createGateway, type Gateway, type GatewayOptions } from "../core/gateway.js";
import { getWorkspaceId } from "./workspace-registry.js";

export type WorkspaceRuntimeState =
  | "loading"
  | "ready"
  | "reloading"
  | "failed"
  | "idle"
  | "disposed";

/** Inputs needed to create one isolated project/config runtime. */
export interface WorkspaceRuntimeInput extends RuntimeExecutionContextInput {
  directory: string;
  configPath: string;
  config: RouterMcpConfig;
  /** Config revision; it is metadata and is not part of the context key. */
  configDigest?: string;
}

/** Canonical, immutable values passed to a runtime factory. */
export interface WorkspaceRuntimeContext {
  readonly id: string;
  readonly key: string;
  readonly directory: string;
  readonly configPath: string;
  readonly config: RouterMcpConfig;
  readonly configDigest?: string;
  readonly execution: RuntimeExecutionContext;
}

/** Services owned by one context. A factory returns fully initialized services. */
export interface WorkspaceRuntimeResource {
  gateway: Gateway;
  dispose?: () => Promise<void> | void;
}

export type WorkspaceRuntimeFactory = (
  context: WorkspaceRuntimeContext,
) => Promise<WorkspaceRuntimeResource> | WorkspaceRuntimeResource;

export interface WorkspaceRuntimeManagerOptions {
  /** Override runtime construction for a host adapter or deterministic tests. */
  factory?: WorkspaceRuntimeFactory;
  /** Automatically dispose unleased contexts after this delay. Disabled by default. */
  idleTimeoutMs?: number;
  /** Gateway options shared by all contexts; config and execution are per context. */
  gatewayOptions?: Partial<Omit<GatewayOptions, "config" | "executionContext">>;
  /** Override path canonicalization for tests and embedders. */
  canonicalizePath?: (path: string) => Promise<string>;
}

export interface WorkspaceRuntimeSnapshot {
  id: string;
  key: string;
  directory: string;
  configPath: string;
  configDigest?: string;
  state: WorkspaceRuntimeState;
  activeLeases: number;
  createdAt?: number;
  lastError?: string;
}

export interface WorkspaceRuntimeLease {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceId: string;
  release(): Promise<void>;
}

export type WorkspaceRuntimeOperation<T> = (
  runtime: WorkspaceRuntime,
) => T | Promise<T>;

export class WorkspaceRuntimeBusyError extends Error {
  constructor(message = "Workspace runtime has active leases") {
    super(message);
    this.name = "WorkspaceRuntimeBusyError";
  }
}

export class WorkspaceRuntimeDisposedError extends Error {
  constructor(message = "Workspace runtime was disposed before it became ready") {
    super(message);
    this.name = "WorkspaceRuntimeDisposedError";
  }
}

/**
 * A running context and its isolated gateway state.
 *
 * The manager owns the instance. Consumers should use `acquire()` when they
 * hold a bridge/session lease; direct `getOrCreate()` is intended for host
 * dispatch and keeps the context alive until the host explicitly disposes it.
 */
export interface WorkspaceRuntime {
  readonly context: WorkspaceRuntimeContext;
  readonly gateway: Gateway;
  readonly createdAt: number;
  dispose(): Promise<void>;
}

interface RuntimeEntry {
  context: WorkspaceRuntimeContext;
  state: WorkspaceRuntimeState;
  runtime: ManagedWorkspaceRuntime | null;
  creationPromise: Promise<ManagedWorkspaceRuntime> | null;
  reloadPromise: Promise<ManagedWorkspaceRuntime> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  disposeRequested: boolean;
  activeLeases: number;
  createdAt?: number;
  lastError?: string;
}

/**
 * Owns one lazily-created gateway per canonical directory/config pair.
 *
 * The key deliberately excludes the config digest. A changed digest is a
 * new revision of the same context and must go through `reload()` so callers
 * cannot silently replace the execution environment of an active context.
 */
export class WorkspaceRuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly factory: WorkspaceRuntimeFactory;
  private readonly idleTimeoutMs: number;
  private readonly canonicalize: (path: string) => Promise<string>;
  private readonly gatewayOptions: Partial<Omit<GatewayOptions, "config" | "executionContext">>;

  constructor(options: WorkspaceRuntimeManagerOptions = {}) {
    this.idleTimeoutMs = validateIdleTimeout(options.idleTimeoutMs ?? 0);
    this.canonicalize = options.canonicalizePath ?? canonicalizePath;
    this.gatewayOptions = options.gatewayOptions ?? {};
    this.factory = options.factory ?? ((context) => this.createDefaultRuntime(context));
  }

  /** Return an existing runtime or create one with single-flight semantics. */
  async getOrCreate(input: WorkspaceRuntimeInput): Promise<WorkspaceRuntime> {
    const context = await this.canonicalizeContext(input);
    let entry = this.entries.get(context.key);

    if (entry?.state === "reloading" && entry.reloadPromise) {
      await entry.reloadPromise;
      entry = this.entries.get(context.key);
    }

    if (entry?.state === "loading" && entry.creationPromise) {
      return entry.creationPromise;
    }

    if (entry?.state === "ready" || entry?.state === "idle") {
      this.cancelIdleDisposal(entry);
      entry.state = "ready";
      return this.requireRuntime(entry);
    }

    // A failed context remains inspectable through snapshots, while the next
    // invocation retries it after its configuration/upstream has been fixed.
    if (entry?.state === "failed" || entry?.state === "disposed") {
      this.entries.delete(context.key);
      entry = undefined;
    }

    if (!entry) {
      entry = this.createEntry(context);
      this.entries.set(context.key, entry);
    }

    return entry.creationPromise as Promise<WorkspaceRuntime>;
  }

  /** Acquire a context lease that prevents idle disposal until released. */
  async acquire(input: WorkspaceRuntimeInput): Promise<WorkspaceRuntimeLease> {
    const context = await this.canonicalizeContext(input);
    const runtime = await this.getOrCreate(input);
    const entry = this.entries.get(context.key);
    if (!entry || entry.runtime !== runtime) {
      throw new WorkspaceRuntimeDisposedError("Workspace runtime disappeared during acquisition");
    }

    entry.activeLeases += 1;
    entry.state = "ready";
    this.cancelIdleDisposal(entry);

    let released = false;
    return {
      runtime,
      workspaceId: context.id,
      release: async () => {
        if (released) return;
        released = true;
        await this.release(context.key, runtime);
      },
    };
  }

  /**
   * Run a host dispatch operation against the selected context while holding
   * its lease. This is the intended bridge between request routing and the
   * manager: a request for B cannot accidentally execute on A, and an idle
   * timer cannot dispose B while the operation is in flight.
   */
  async withRuntime<T>(
    input: WorkspaceRuntimeInput,
    operation: WorkspaceRuntimeOperation<T>,
  ): Promise<T> {
    const lease = await this.acquire(input);
    try {
      return await operation(lease.runtime);
    } finally {
      await lease.release();
    }
  }

  /** Reload a context while retaining its original cwd/environment snapshot. */
  async reload(input: WorkspaceRuntimeInput): Promise<WorkspaceRuntime> {
    const candidate = await this.canonicalizeContext(input);
    let entry = this.entries.get(candidate.key);

    if (!entry) {
      return this.getOrCreate(input);
    }
    if (entry.state === "loading" && entry.creationPromise) {
      await entry.creationPromise;
      entry = this.entries.get(candidate.key);
      if (!entry) return this.getOrCreate(input);
    }
    if (entry.state === "reloading" && entry.reloadPromise) {
      return entry.reloadPromise;
    }

    const oldRuntime = this.requireRuntime(entry);
    const context: WorkspaceRuntimeContext = {
      ...candidate,
      ...(candidate.configDigest === undefined && oldRuntime.context.configDigest !== undefined
        ? { configDigest: oldRuntime.context.configDigest }
        : {}),
      // A reload changes the desired config revision while preserving the
      // environment/cwd chosen by the first caller of this context.
      execution: oldRuntime.context.execution,
    };

    entry.context = context;
    entry.state = "reloading";
    entry.lastError = undefined;

    const reloadPromise = this.createReload(entry, oldRuntime, context);
    entry.reloadPromise = reloadPromise;
    try {
      return await reloadPromise;
    } finally {
      if (entry.reloadPromise === reloadPromise) entry.reloadPromise = null;
    }
  }

  /** Dispose one context, optionally abandoning active leases. */
  async dispose(input: WorkspaceRuntimeInput | string, options: { force?: boolean } = {}): Promise<void> {
    const key = typeof input === "string" ? input : (await this.canonicalizeContext(input)).key;
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.activeLeases > 0 && options.force !== true) {
      throw new WorkspaceRuntimeBusyError();
    }

    this.cancelIdleDisposal(entry);
    if (entry.state === "loading" && entry.creationPromise) {
      entry.disposeRequested = true;
      await entry.creationPromise.catch(() => undefined);
      return;
    }
    if (entry.state === "reloading" && entry.reloadPromise) {
      await entry.reloadPromise.catch(() => undefined);
    }

    entry.state = "disposed";
    await entry.runtime?.dispose();
    entry.runtime = null;
  }

  get(workspaceId: string): WorkspaceRuntime | undefined {
    const entry = Array.from(this.entries.values()).find((candidate) => candidate.context.id === workspaceId);
    if (!entry || entry.state === "disposed" || entry.state === "failed") return undefined;
    return entry.runtime ?? undefined;
  }

  getSnapshot(workspaceId: string): WorkspaceRuntimeSnapshot | undefined {
    const entry = Array.from(this.entries.values()).find((candidate) => candidate.context.id === workspaceId);
    return entry ? toSnapshot(entry) : undefined;
  }

  listSnapshots(): WorkspaceRuntimeSnapshot[] {
    return Array.from(this.entries.values(), toSnapshot).sort((left, right) => {
      return (right.createdAt ?? 0) - (left.createdAt ?? 0);
    });
  }

  /** Dispose every live context during host shutdown. */
  async disposeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of this.entries.values()) {
      try {
        await this.dispose(entry.context.key, { force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more workspace runtimes failed to dispose");
    }
  }

  private createEntry(context: WorkspaceRuntimeContext): RuntimeEntry {
    const entry: RuntimeEntry = {
      context,
      state: "loading",
      runtime: null,
      creationPromise: null,
      reloadPromise: null,
      idleTimer: null,
      disposeRequested: false,
      activeLeases: 0,
    };
    entry.creationPromise = this.createRuntime(entry, context);
    return entry;
  }

  private async createRuntime(
    entry: RuntimeEntry,
    context: WorkspaceRuntimeContext,
  ): Promise<ManagedWorkspaceRuntime> {
    try {
      const resource = await this.factory(context);
      const runtime = new ManagedWorkspaceRuntime(context, resource);
      if (entry.disposeRequested) {
        await runtime.dispose();
        entry.state = "disposed";
        throw new WorkspaceRuntimeDisposedError();
      }
      entry.runtime = runtime;
      entry.createdAt = runtime.createdAt;
      entry.state = "ready";
      entry.lastError = undefined;
      return runtime;
    } catch (error) {
      if (!(error instanceof WorkspaceRuntimeDisposedError)) {
        entry.state = "failed";
        entry.lastError = errorMessage(error);
      }
      throw error;
    } finally {
      entry.creationPromise = null;
    }
  }

  private async createReload(
    entry: RuntimeEntry,
    oldRuntime: ManagedWorkspaceRuntime,
    context: WorkspaceRuntimeContext,
  ): Promise<ManagedWorkspaceRuntime> {
    try {
      const resource = await this.factory(context);
      const nextRuntime = new ManagedWorkspaceRuntime(context, resource);
      entry.runtime = nextRuntime;
      entry.createdAt = nextRuntime.createdAt;
      entry.state = "ready";
      entry.lastError = undefined;
      // Swap first so a concurrent dispatcher sees a healthy replacement. A
      // disposal failure must not poison the new context or another context.
      await oldRuntime.dispose().catch((error) => {
        entry.lastError = `Previous runtime cleanup failed: ${errorMessage(error)}`;
      });
      return nextRuntime;
    } catch (error) {
      entry.state = "ready";
      entry.lastError = errorMessage(error);
      throw error;
    }
  }

  private async release(key: string, _runtime: WorkspaceRuntime): Promise<void> {
    const entry = this.entries.get(key);
    // A lease may outlive a reload. Its ownership is tied to the context key,
    // while the entry's runtime pointer moves to the replacement instance.
    // Keep the argument in the signature so callers can retain the runtime
    // they acquired and make repeated release calls idempotent at the lease.
    if (!entry || entry.activeLeases === 0) return;
    entry.activeLeases -= 1;
    if (entry.activeLeases !== 0 || this.idleTimeoutMs <= 0) return;

    entry.state = "idle";
    const currentRuntime = entry.runtime;
    if (!currentRuntime) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.activeLeases === 0 && entry.runtime === currentRuntime && entry.state === "idle") {
        void this.dispose(key, { force: true }).catch((error) => {
          entry.lastError = `Idle disposal failed: ${errorMessage(error)}`;
        });
      }
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private cancelIdleDisposal(entry: RuntimeEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private async canonicalizeContext(input: WorkspaceRuntimeInput): Promise<WorkspaceRuntimeContext> {
    validateInput(input);
    const directory = await this.canonicalize(input.directory);
    const configPath = await this.canonicalize(input.configPath);
    const execution = createRuntimeExecutionContext(
      { cwd: input.cwd, env: input.env },
      directory,
    );
    const id = getWorkspaceId(directory, configPath);
    const config = deepFreeze(cloneConfig(input.config));
    return {
      id,
      key: `${directory}\u0000${configPath}`,
      directory,
      configPath,
      config,
      ...(input.configDigest !== undefined ? { configDigest: input.configDigest } : {}),
      execution,
    };
  }

  private async createDefaultRuntime(
    context: WorkspaceRuntimeContext,
  ): Promise<WorkspaceRuntimeResource> {
    const gateway = createGateway({
      ...this.gatewayOptions,
      config: context.config,
      // Context gateways are request handlers owned by the host. The host
      // supplies the actual listener/dispatch transport in its integration.
      mode: this.gatewayOptions.mode ?? "stdio",
      executionContext: context.execution,
    });
    try {
      await gateway.start();
      return { gateway };
    } catch (error) {
      await gateway.stop().catch(() => undefined);
      throw error;
    }
  }

  private requireRuntime(entry: RuntimeEntry): ManagedWorkspaceRuntime {
    if (!entry.runtime) {
      throw new WorkspaceRuntimeDisposedError(`Workspace runtime ${entry.context.id} is unavailable`);
    }
    return entry.runtime;
  }
}

class ManagedWorkspaceRuntime implements WorkspaceRuntime {
  readonly createdAt = Date.now();
  private disposePromise: Promise<void> | null = null;

  constructor(
    readonly context: WorkspaceRuntimeContext,
    private readonly resource: WorkspaceRuntimeResource,
  ) {}

  get gateway(): Gateway {
    return this.resource.gateway;
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.resource.dispose
      ? Promise.resolve(this.resource.dispose())
      : Promise.resolve(this.gateway.stop());
    return this.disposePromise;
  }
}

function toSnapshot(entry: RuntimeEntry): WorkspaceRuntimeSnapshot {
  return {
    id: entry.context.id,
    key: entry.context.key,
    directory: entry.context.directory,
    configPath: entry.context.configPath,
    ...(entry.context.configDigest !== undefined
      ? { configDigest: entry.context.configDigest }
      : {}),
    state: entry.state,
    activeLeases: entry.activeLeases,
    ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  };
}

function validateInput(input: WorkspaceRuntimeInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("Workspace runtime input is required");
  }
  for (const [name, value] of [
    ["directory", input.directory],
    ["configPath", input.configPath],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`Workspace runtime ${name} must be a non-empty string`);
    }
  }
  if (!input.config || typeof input.config !== "object" || !input.config.mcpServers) {
    throw new TypeError("Workspace runtime config must contain mcpServers");
  }
}

function validateIdleTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Workspace runtime idleTimeoutMs must be a non-negative finite number");
  }
  return value;
}

async function canonicalizePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return absolute;
    throw error;
  }
}

function cloneConfig(config: RouterMcpConfig): RouterMcpConfig {
  return structuredClone(config);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
