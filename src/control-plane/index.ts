import type { ConnectionLease } from "../daemon/connection-tracker.js";
import { CONTROL_PLANE_HEALTH_PATH, CONTROL_PLANE_PATH } from "./paths.js";

export { CONTROL_PLANE_HEALTH_PATH, CONTROL_PLANE_PATH } from "./paths.js";

export {
  DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS,
  DEFAULT_MAX_MANAGEMENT_CREDENTIALS,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
  MANAGEMENT_CREDENTIAL_SCOPE,
  MAX_MANAGEMENT_CREDENTIAL_TTL_MS,
  ManagementCredentialStore,
  type ManagementCredentialGrant,
  type ManagementCredentialStoreOptions,
} from "./management-credentials.js";
export const CONTROL_PLANE_DEFAULT_EVENT_LIMIT = 40;
export const CONTROL_PLANE_MAX_EVENT_LIMIT = 200;
export const CONTROL_PLANE_EVENT_BUFFER_SIZE = 1_000;

export type ControlPlaneDaemonState =
  | "starting"
  | "ready"
  | "degraded"
  | "failed"
  | "stopping"
  | "offline";
export type ControlPlaneServerState = "online" | "offline" | "degraded" | "starting" | "unknown";
export type ControlPlaneSessionKind = "bridge" | "mcp" | "control";
export type ControlPlaneSessionState = "active" | "idle" | "expired" | "closing";
export type ControlPlaneEventLevel = "debug" | "info" | "warn" | "error";

export interface ControlPlaneStatus {
  state: ControlPlaneDaemonState;
  instanceId: string;
  pid?: number;
  version: string;
  protocolVersion: string;
  profile: string;
  configDigest: string;
  host: string;
  port: number;
  mcpUrl: string;
  controlUrl: string;
  startedAt: string;
  uptimeSeconds: number;
}

export interface ControlPlaneServer {
  id: string;
  name: string;
  url?: string;
  transport?: string;
  state: ControlPlaneServerState;
  toolCount: number;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface ControlPlaneSession {
  id: string;
  kind: ControlPlaneSessionKind;
  clientName?: string;
  clientVersion?: string;
  profile?: string;
  state: ControlPlaneSessionState;
  connectedAt: string;
  lastSeenAt: string;
  leaseExpiresAt?: string;
}

export interface ControlPlaneMetrics {
  requestsTotal: number;
  requestsPerSecond: number;
  errorsTotal: number;
  errorRate: number;
  toolCallsTotal: number;
  activeSessions: number;
  activeLeases: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
  };
}

export interface ControlPlaneEvent {
  id: string;
  timestamp: string;
  level: ControlPlaneEventLevel;
  type: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ControlPlaneRestartResult {
  accepted: boolean;
  message: string;
  state?: ControlPlaneDaemonState;
}

export interface ControlPlaneSource {
  getStatus: () => ControlPlaneStatus;
  getServers: () => ControlPlaneServer[];
  getSessions: () => ControlPlaneSession[];
  getLeases?: () => readonly ConnectionLease[];
  restart?: () => Promise<ControlPlaneRestartResult> | ControlPlaneRestartResult;
  now?: () => number;
}

export interface ControlPlaneRequestObservation {
  durationMs: number;
  method?: string;
  error?: boolean;
  /** A JSON-RPC result with isError=true is an application error. */
  resultError?: boolean;
}

/**
 * In-process control-plane state. The HTTP transport only knows how to
 * serialize this object; all daemon-specific snapshots are supplied through
 * the source callbacks. Keeping counters and events here avoids coupling the
 * management API to the MCP protocol implementation.
 */
export class ControlPlane {
  private readonly source: ControlPlaneSource;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly events: ControlPlaneEvent[] = [];
  private readonly latencySamples: number[] = [];
  private requestsTotal = 0;
  private errorsTotal = 0;
  private toolCallsTotal = 0;
  private restartInFlight: Promise<ControlPlaneRestartResult> | null = null;

  constructor(source: ControlPlaneSource) {
    this.source = source;
    this.now = source.now ?? Date.now;
    this.startedAt = this.now();
  }

  getStatus(): ControlPlaneStatus {
    const status = this.source.getStatus();
    return {
      state: status.state,
      instanceId: sanitizeText(status.instanceId),
      ...(isSafePid(status.pid) ? { pid: status.pid } : {}),
      version: sanitizeText(status.version),
      protocolVersion: sanitizeText(status.protocolVersion),
      profile: sanitizeText(status.profile),
      configDigest: sanitizeText(status.configDigest),
      host: sanitizeText(status.host),
      port: normalizeCount(status.port),
      mcpUrl: sanitizeUrl(status.mcpUrl) ?? "",
      controlUrl: sanitizeUrl(status.controlUrl) ?? "",
      startedAt: sanitizeText(status.startedAt),
      uptimeSeconds: normalizeMetric(status.uptimeSeconds),
    };
  }

  getServers(): ControlPlaneServer[] {
    return this.source.getServers().map((server) => {
      const url = server.url ? sanitizeUrl(server.url) : undefined;
      const lastCheckedAt = server.lastCheckedAt
        ? sanitizeText(server.lastCheckedAt)
        : undefined;
      const lastError = server.lastError ? sanitizeText(server.lastError) : undefined;

      return {
        id: sanitizeText(server.id),
        name: sanitizeText(server.name),
        ...(url ? { url } : {}),
        ...(server.transport ? { transport: sanitizeText(server.transport) } : {}),
        state: server.state,
        toolCount: normalizeCount(server.toolCount),
        ...(isFiniteMetric(server.latencyMs) ? { latencyMs: normalizeMetric(server.latencyMs) } : {}),
        ...(lastCheckedAt ? { lastCheckedAt } : {}),
        ...(lastError ? { lastError } : {}),
      };
    });
  }

  getSessions(): ControlPlaneSession[] {
    return this.source.getSessions().map((session) => ({
      id: sanitizeText(session.id),
      kind: session.kind,
      ...(session.clientName ? { clientName: sanitizeText(session.clientName) } : {}),
      ...(session.clientVersion ? { clientVersion: sanitizeText(session.clientVersion) } : {}),
      ...(session.profile ? { profile: sanitizeText(session.profile) } : {}),
      state: session.state,
      connectedAt: sanitizeText(session.connectedAt),
      lastSeenAt: sanitizeText(session.lastSeenAt),
      ...(session.leaseExpiresAt ? { leaseExpiresAt: sanitizeText(session.leaseExpiresAt) } : {}),
    }));
  }

  getMetrics(): ControlPlaneMetrics {
    const elapsedSeconds = Math.max((this.now() - this.startedAt) / 1_000, 1);
    const activeSessions = this.source.getSessions().length;
    const activeLeases = this.source.getLeases?.().length ?? 0;
    const requestsPerSecond = this.requestsTotal / elapsedSeconds;
    const errorRate = this.requestsTotal === 0 ? 0 : (this.errorsTotal / this.requestsTotal) * 100;

    return {
      requestsTotal: this.requestsTotal,
      requestsPerSecond: roundMetric(requestsPerSecond),
      errorsTotal: this.errorsTotal,
      errorRate: roundMetric(errorRate),
      toolCallsTotal: this.toolCallsTotal,
      activeSessions,
      activeLeases,
      latencyMs: {
        p50: percentile(this.latencySamples, 0.5),
        p95: percentile(this.latencySamples, 0.95),
        p99: percentile(this.latencySamples, 0.99),
      },
    };
  }

  getEvents(limit = CONTROL_PLANE_DEFAULT_EVENT_LIMIT): ControlPlaneEvent[] {
    const boundedLimit = boundEventLimit(limit);
    return this.events.slice(0, boundedLimit).map((event) => cloneEvent(event));
  }

  recordRequest(observation: ControlPlaneRequestObservation): void {
    this.requestsTotal += 1;
    if (observation.method === "tools/call") this.toolCallsTotal += 1;
    if (observation.error === true || observation.resultError === true) this.errorsTotal += 1;

    const durationMs = normalizeLatency(observation.durationMs);
    this.latencySamples.push(durationMs);
    if (this.latencySamples.length > CONTROL_PLANE_EVENT_BUFFER_SIZE) {
      this.latencySamples.shift();
    }
  }

  recordEvent(
    event: Omit<ControlPlaneEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
  ): ControlPlaneEvent {
    const next: ControlPlaneEvent = {
      id: event.id && event.id.length > 0 ? event.id : crypto.randomUUID(),
      timestamp: event.timestamp ?? new Date(this.now()).toISOString(),
      level: event.level,
      type: sanitizeText(event.type),
      message: sanitizeText(event.message),
      ...(event.metadata ? { metadata: sanitizeMetadata(event.metadata) } : {}),
    };
    this.events.unshift(next);
    if (this.events.length > CONTROL_PLANE_EVENT_BUFFER_SIZE) {
      this.events.length = CONTROL_PLANE_EVENT_BUFFER_SIZE;
    }
    return cloneEvent(next);
  }

  async restart(): Promise<ControlPlaneRestartResult> {
    if (this.restartInFlight) return this.restartInFlight;

    if (!this.source.restart) {
      return {
        accepted: false,
        message: "In-process daemon restart is not available for this server",
      };
    }

    this.restartInFlight = Promise.resolve()
      .then(() => this.source.restart?.() ?? { accepted: false, message: "Restart unavailable" })
      .then((result) => ({ ...result }))
      .finally(() => {
        this.restartInFlight = null;
      });
    return this.restartInFlight;
  }
}

export function boundEventLimit(value: number): number {
  if (!Number.isFinite(value)) return CONTROL_PLANE_DEFAULT_EVENT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), CONTROL_PLANE_MAX_EVENT_LIMIT);
}

function normalizeLatency(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function isFiniteMetric(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function normalizeMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isSafePid(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ratio * ordered.length) - 1));
  return Math.round(ordered[index] ?? 0);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function cloneEvent(event: ControlPlaneEvent): ControlPlaneEvent {
  return {
    ...event,
    ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
  };
}

function sanitizeMetadata(
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      sanitizeText(key),
      typeof value === "string" ? sanitizeText(value) : value,
    ]),
  );
}

/** Keep credentials and URL query material out of the browser-visible feed. */
export function sanitizeText(value: string): string {
  let sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  sanitized = sanitized.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  sanitized = sanitized.replace(
    /([?&](?:token|access_token|refresh_token|api[_-]?key|key|secret|password)=)[^&\s]+/gi,
    "$1[redacted]",
  );
  sanitized = sanitized.replace(
    /([a-z][a-z\d+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    "$1[redacted]@",
  );
  return sanitized;
}

export function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return sanitizeText(value);
  }
}

export * from "./pairing.js";
