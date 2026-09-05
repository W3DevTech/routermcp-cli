import { randomUUID } from "node:crypto";
import type { ExecutionOperation } from "./execution-service.js";

export const DEFAULT_EXECUTION_MAX_CONCURRENCY = 4;
export const DEFAULT_EXECUTION_MAX_QUEUED = 32;
export const DEFAULT_EXECUTION_JOB_TTL_MS = 10 * 60_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;
export const EXECUTION_OUTPUT_MAX_BYTES = 256 * 1024;

export type ExecutionJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface ExecutionJobError {
  code: string;
  message: string;
}

export interface ExecutionJobSnapshot {
  id: string;
  workspaceId: string;
  operation: ExecutionOperation;
  state: ExecutionJobState;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: unknown;
  error?: ExecutionJobError;
}

export interface ExecutionJobEvent {
  operation: ExecutionOperation;
  workspaceId: string;
  jobId: string;
  status: ExecutionJobState;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ExecutionJobManagerOptions {
  maxConcurrencyPerWorkspace?: number;
  maxQueuedPerWorkspace?: number;
  jobTtlMs?: number;
  outputMaxBytes?: number;
  executionTimeoutMs?: number;
  now?: () => number;
  onEvent?: (event: ExecutionJobEvent) => void;
}

export class ExecutionJobQueueFullError extends Error {
  readonly code = "queue-full";
  readonly status = 429;

  constructor() {
    super("Too many execution jobs are queued for this workspace");
    this.name = "ExecutionJobQueueFullError";
  }
}

interface ExecutionJobRecord extends ExecutionJobSnapshot {
  run: () => Promise<unknown>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Small in-memory job queue for local daemon execution. Jobs are intentionally
 * process-local: the daemon is the durable owner of the workspace runtimes,
 * while the hosted UI only polls this bounded status surface.
 */
export class ExecutionJobManager {
  private readonly jobs = new Map<string, ExecutionJobRecord>();
  private readonly queues = new Map<string, string[]>();
  private readonly active = new Map<string, number>();
  private readonly maxConcurrency: number;
  private readonly maxQueued: number;
  private readonly ttlMs: number;
  private readonly outputMaxBytes: number;
  private readonly executionTimeoutMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (event: ExecutionJobEvent) => void;

  constructor(options: ExecutionJobManagerOptions = {}) {
    this.maxConcurrency = positiveInteger(
      options.maxConcurrencyPerWorkspace ?? DEFAULT_EXECUTION_MAX_CONCURRENCY,
    );
    this.maxQueued = positiveInteger(options.maxQueuedPerWorkspace ?? DEFAULT_EXECUTION_MAX_QUEUED);
    this.ttlMs = positiveInteger(options.jobTtlMs ?? DEFAULT_EXECUTION_JOB_TTL_MS);
    this.outputMaxBytes = positiveInteger(options.outputMaxBytes ?? EXECUTION_OUTPUT_MAX_BYTES);
    this.executionTimeoutMs = positiveInteger(options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  submit(
    workspaceId: string,
    operation: ExecutionOperation,
    run: () => Promise<unknown>,
  ): ExecutionJobSnapshot {
    const queue = this.queues.get(workspaceId) ?? [];
    if (queue.length >= this.maxQueued) throw new ExecutionJobQueueFullError();

    const id = randomUUID();
    const record: ExecutionJobRecord = {
      id,
      workspaceId,
      operation,
      state: "queued",
      createdAt: this.timestamp(),
      run,
      expiryTimer: null,
      timeoutTimer: null,
    };
    this.jobs.set(id, record);
    queue.push(id);
    this.queues.set(workspaceId, queue);
    this.emit(record);
    this.pump(workspaceId);
    return this.snapshot(record);
  }

  get(workspaceId: string, jobId: string): ExecutionJobSnapshot | null {
    const record = this.jobs.get(jobId);
    if (!record || record.workspaceId !== workspaceId) return null;
    if (record.state !== "expired" && this.now() - Date.parse(record.createdAt) >= this.ttlMs) {
      this.expire(record);
    }
    return this.snapshot(record);
  }

  cancel(workspaceId: string, jobId: string): ExecutionJobSnapshot | null {
    const record = this.jobs.get(jobId);
    if (!record || record.workspaceId !== workspaceId) return null;
    if (record.state === "queued") {
      record.state = "cancelled";
      record.completedAt = this.timestamp();
      record.error = { code: "cancelled", message: "Execution job was cancelled" };
      this.removeFromQueue(record);
      this.emit(record);
      this.scheduleExpiry(record);
      this.pump(workspaceId);
    } else if (record.state === "running") {
      // The underlying MCP SDK does not expose cancellation for every
      // upstream transport. Mark the job terminal immediately and prevent its
      // eventual completion from replacing this explicit user decision.
      record.state = "cancelled";
      record.completedAt = this.timestamp();
      record.durationMs = this.duration(record);
      record.error = { code: "cancelled", message: "Execution cancellation requested" };
      if (record.timeoutTimer) {
        clearTimeout(record.timeoutTimer);
        record.timeoutTimer = null;
      }
      this.emit(record);
      this.scheduleExpiry(record);
    }
    return this.snapshot(record);
  }

  clear(): void {
    for (const record of this.jobs.values()) {
      if (record.expiryTimer) clearTimeout(record.expiryTimer);
      if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
    }
    this.jobs.clear();
    this.queues.clear();
    this.active.clear();
  }

  private pump(workspaceId: string): void {
    const queue = this.queues.get(workspaceId);
    if (!queue) return;
    const active = this.active.get(workspaceId) ?? 0;
    if (active >= this.maxConcurrency) return;

    const jobId = queue.shift();
    if (!jobId) {
      if (queue.length === 0) this.queues.delete(workspaceId);
      return;
    }
    const record = this.jobs.get(jobId);
    if (!record || record.state !== "queued") {
      this.pump(workspaceId);
      return;
    }

    record.state = "running";
    record.startedAt = this.timestamp();
    this.active.set(workspaceId, active + 1);
    this.emit(record);

    record.timeoutTimer = setTimeout(() => {
      if (record.state === "running") {
        this.fail(record, "timeout", "Execution exceeded the daemon timeout");
      }
    }, this.executionTimeoutMs);
    record.timeoutTimer.unref?.();

    void record
      .run()
      .then((result) => {
        if (record.state !== "running") return;
        const bounded = boundOutput(result, this.outputMaxBytes);
        if (!bounded.ok) {
          this.fail(record, "output-too-large", "Execution output exceeded the daemon limit");
          return;
        }
        record.state = "succeeded";
        record.result = bounded.value;
        record.completedAt = this.timestamp();
        record.durationMs = this.duration(record);
        this.emit(record);
        this.scheduleExpiry(record);
      })
      .catch((error: unknown) => {
        if (record.state !== "running") return;
        const failure = safeErrorDetails(error);
        this.fail(record, failure.code, failure.message);
      })
      .finally(() => {
        if (record.timeoutTimer) {
          clearTimeout(record.timeoutTimer);
          record.timeoutTimer = null;
        }
        this.active.set(workspaceId, Math.max(0, (this.active.get(workspaceId) ?? 1) - 1));
        this.pump(workspaceId);
      });

    // Fill all available slots in this workspace in one submission turn.
    this.pump(workspaceId);
  }

  private fail(record: ExecutionJobRecord, code: string, message: string): void {
    record.state = "failed";
    record.completedAt = this.timestamp();
    record.durationMs = this.duration(record);
    record.error = { code, message };
    this.emit(record);
    this.scheduleExpiry(record);
  }

  private expire(record: ExecutionJobRecord): void {
    if (record.state === "queued" || record.state === "running") return;
    record.state = "expired";
    record.result = undefined;
    record.error = { code: "expired", message: "Execution job result has expired" };
    this.emit(record);
  }

  private scheduleExpiry(record: ExecutionJobRecord): void {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = setTimeout(() => this.expire(record), this.ttlMs);
    record.expiryTimer.unref?.();
  }

  private removeFromQueue(record: ExecutionJobRecord): void {
    const queue = this.queues.get(record.workspaceId);
    if (!queue) return;
    const index = queue.indexOf(record.id);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(record.workspaceId);
  }

  private snapshot(record: ExecutionJobRecord): ExecutionJobSnapshot {
    const { run: _run, expiryTimer: _expiryTimer, timeoutTimer: _timeoutTimer, ...snapshot } = record;
    return {
      ...snapshot,
      ...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
      ...(snapshot.error ? { error: { ...snapshot.error } } : {}),
    };
  }

  private emit(record: ExecutionJobRecord): void {
    this.onEvent?.({
      operation: record.operation,
      workspaceId: record.workspaceId,
      jobId: record.id,
      status: record.state,
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.error?.code ? { errorCode: record.error.code } : {}),
      ...(record.error?.message ? { errorMessage: record.error.message } : {}),
    });
  }

  private duration(record: ExecutionJobRecord): number {
    const startedAt = record.startedAt ? Date.parse(record.startedAt) : Date.parse(record.createdAt);
    return Math.max(0, this.now() - startedAt);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function positiveInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function safeErrorDetails(error: unknown): { code: string; message: string } {
  // Do not copy arbitrary upstream error text into browser-visible job state.
  // The operation result itself is still available when it is a structured
  // MCP application error; thrown transport failures get this generic code.
  if (error instanceof Error && error.name === "ExecutionError" && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "execution-failed",
      message: error.message,
    };
  }
  return { code: "execution-failed", message: "The execution request failed" };
}

interface BoundedOutput {
  ok: boolean;
  value?: unknown;
}

function boundOutput(value: unknown, maxBytes: number): BoundedOutput {
  const bounded = boundValue(value, 0, new WeakSet<object>());
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(bounded));
    return encoded.byteLength <= maxBytes ? { ok: true, value: bounded } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function boundValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 8_192 ? `${value.slice(0, 8_192)}…` : value;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => boundValue(entry, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (isSensitiveKey(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = boundValue(entry, depth + 1, seen);
    }
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /(authorization|cookie|password|secret|token|api[-_]?key|credential|private[-_]?key)/i.test(
    key,
  );
}
