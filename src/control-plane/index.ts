import { ExecutionJobManager, type ExecutionJobSnapshot } from "../core/execution-jobs.js";
import type {
  ExecutionSearchResult,
  ExecutionService,
  ExecutionTool,
  ExecutionToolQueryOptions,
  ToolSearchPage,
} from "../core/execution-service.js";
import { ExecutionError } from "../core/execution-service.js";
import type { ConnectionLease } from "../daemon/connection-tracker.js";
import type {
  ControlPlaneFeatures,
  ControlPlaneManagementSource,
  ControlPlaneMutationResult,
  ManagementRestartState,
  ServerEnabledPatch,
} from "./management.js";
import { isValidWorkspaceId } from "./management-credentials.js";

export {
  CODE_MODE_TIMEOUT_MAX_MS,
  CODE_MODE_TIMEOUT_MIN_MS,
  CONTROL_PLANE_EXECUTION_MODES,
  type ConfigFileSnapshot,
  ConfigMutationError,
  type ConfigMutationErrorCode,
  type ConfigMutationResult,
  ConfigRevisionConflictError,
  type ConfigServerKind,
  type ConfigServerReference,
  createExecutionModeSnapshot,
  digestConfigSource,
  type ExecutionModePatch,
  type ExecutionModeSnapshot,
  getExecutionMode,
  MANAGEMENT_BODY_LIMIT_BYTES,
  parseConfigServerId,
  parseExecutionModePatch,
  parseManagementJsonBody,
  parseServerEnabledPatch,
  readConfigSnapshot,
  type SetExecutionModeOptions,
  type SetServerEnabledOptions,
  setExecutionMode,
  setServerEnabled,
} from "../config/mutation.js";
export {
  BROWSER_MANAGEMENT_PROTOCOL_VERSION,
  type BrowserDevicePublicKey,
  type BrowserDeviceRecord,
  type BrowserDeviceRegistration,
  type BrowserManagementChallenge,
  BrowserManagementError,
  type BrowserManagementExchange,
  type BrowserManagementExchangeResult,
  BrowserManagementSessionStore,
  type BrowserManagementSessionStoreOptions,
  browserChallengeSigningPayload,
  CONTROL_PLANE_BROWSER_CHALLENGE_PATH,
  CONTROL_PLANE_BROWSER_DEVICES_PATH,
  CONTROL_PLANE_BROWSER_EXCHANGE_PATH,
  DEFAULT_BROWSER_CHALLENGE_CAPACITY,
  DEFAULT_BROWSER_CHALLENGE_TTL_MS,
  DEFAULT_BROWSER_DEVICE_CAPACITY,
  fingerprintPublicKey,
  MAX_BROWSER_CHALLENGE_TTL_MS,
} from "./browser-management.js";
export {
  type ConfigManagementSourceOptions,
  type ControlPlaneFeatures,
  type ControlPlaneManagementReloadResult,
  type ControlPlaneManagementRestartResult,
  type ControlPlaneManagementSource,
  type ControlPlaneMutationResult,
  createConfigManagementSource,
  type ManagementRestartState,
  type ServerEnabledPatch,
} from "./management.js";

export {
  DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS,
  DEFAULT_MAX_MANAGEMENT_CREDENTIALS,
  isValidWorkspaceId,
  MANAGEMENT_CREDENTIAL_AUTHORITIES,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
  MANAGEMENT_CREDENTIAL_SCOPE,
  MAX_MANAGEMENT_CREDENTIAL_TTL_MS,
  type ManagementCredentialAuthority,
  type ManagementCredentialAuthorization,
  type ManagementCredentialGrant,
  ManagementCredentialStore,
  type ManagementCredentialStoreOptions,
} from "./management-credentials.js";
export { CONTROL_PLANE_HEALTH_PATH, CONTROL_PLANE_PATH } from "./paths.js";
export {
  DEFAULT_MAX_WORKSPACE_MCP_CREDENTIALS,
  WORKSPACE_MCP_CREDENTIALS_SCHEMA_VERSION,
  type WorkspaceMcpCredentialResult,
  WorkspaceMcpCredentialStore,
  type WorkspaceMcpCredentialStoreOptions,
} from "./workspace-mcp-credentials.js";
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
export type ControlPlaneServerKind = "mcp" | "openapi";
export type ControlPlaneWorkspaceState = "current" | "active" | "known" | "stale" | "unavailable";

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
  /** Current workspace selected by the CLI handoff, when one is known. */
  workspaceId?: string;
  workspaceDirectory?: string;
  workspaceConfigPath?: string;
  pendingRestart?: boolean;
  restartState?: ManagementRestartState;
  restartMessage?: string;
}

export interface ControlPlaneServer {
  id: string;
  name: string;
  /** Explicit provider kind prevents mcp/openapi name collisions. */
  kind?: ControlPlaneServerKind;
  url?: string;
  transport?: string;
  /** Desired enabled state from the selected config source. */
  enabled?: boolean;
  /** Live observed state; state remains as a backwards-compatible alias. */
  observedState?: ControlPlaneServerState;
  /** Source revision used to derive the desired state. */
  configRevision?: string;
  lastChangedAt?: string;
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
  workspaceId?: string;
  state: ControlPlaneSessionState;
  connectedAt: string;
  lastSeenAt: string;
  leaseExpiresAt?: string;
}

/** Local-only workspace identity exposed to authenticated management clients. */
export interface ControlPlaneWorkspace {
  id: string;
  directory: string;
  configPath: string;
  configScope: "project-local" | "user-project" | "user-global";
  profileId: string;
  configDigest: string;
  state: ControlPlaneWorkspaceState;
  activeConnections: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastError?: string;
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

/** Complete context snapshot returned by a workspace status route. */
export interface ControlPlaneWorkspaceStatus {
  workspace: ControlPlaneWorkspace;
  status: ControlPlaneStatus;
  servers: ControlPlaneServer[];
  sessions: ControlPlaneSession[];
  metrics: ControlPlaneMetrics;
  /** Desired/effective feature state when the workspace exposes management. */
  features?: ControlPlaneFeatures;
}

export interface ControlPlaneExecutionSource {
  /** Returns only the runtime bound to the requested registered workspace. */
  getWorkspaceExecution: (workspaceId: string) => ExecutionService | null;
}

export type ControlPlaneExecutionRequest =
  | { operation: "tool-call"; name: string; arguments?: unknown }
  | { operation: "code-run"; code: string };

export interface ControlPlaneEvent {
  id: string;
  timestamp: string;
  level: ControlPlaneEventLevel;
  type: string;
  message: string;
  /** Workspace context attached to the originating bridge/request. */
  workspaceId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ControlPlaneRestartResult {
  accepted: boolean;
  message: string;
  state?: ControlPlaneDaemonState;
}

/** Result of explicitly materializing one registered workspace runtime. */
export type ControlPlaneWorkspaceActivationState = "initializing" | "ready" | "error";

export interface ControlPlaneWorkspaceActivationResult {
  workspaceId: string;
  state: ControlPlaneWorkspaceActivationState;
  message: string;
}

export interface ControlPlaneSource {
  getStatus: () => ControlPlaneStatus;
  getServers: () => ControlPlaneServer[];
  getSessions: () => ControlPlaneSession[];
  getLeases?: () => readonly ConnectionLease[];
  /** Context-bound config/mode management; absent on unmanaged servers. */
  management?: ControlPlaneManagementSource;
  /** Optional multi-directory registry snapshots. */
  getWorkspaces?: () => ControlPlaneWorkspace[];
  /** Return a fully scoped snapshot, or null when the workspace is unknown. */
  getWorkspaceStatus?: (workspaceId: string) => ControlPlaneWorkspaceStatus | null;
  /**
   * Async variant used by HTTP management routes when a workspace's desired
   * config may need to be loaded from disk before its first runtime request.
   */
  getWorkspaceStatusAsync?: (
    workspaceId: string,
  ) => ControlPlaneWorkspaceStatus | null | Promise<ControlPlaneWorkspaceStatus | null>;
  /** Optional context-scoped session snapshots for hosts that do not build a full status. */
  getWorkspaceSessions?: (workspaceId: string) => ControlPlaneSession[] | null;
  /** Optional context-scoped metrics for hosts that do not build a full status. */
  getWorkspaceMetrics?: (workspaceId: string) => ControlPlaneMetrics | null;
  /** Optional context-scoped activity feed; inventory events must not cross contexts. */
  getWorkspaceEvents?: (workspaceId: string, limit: number) => ControlPlaneEvent[] | null;
  /** Return the management adapter for a known workspace, if available. */
  getWorkspaceManagement?: (workspaceId: string) => ControlPlaneManagementSource | null;
  /** Optional read-only feature snapshot for a known workspace. */
  getWorkspaceFeatures?: (
    workspaceId: string,
  ) => ControlPlaneFeatures | null | Promise<ControlPlaneFeatures | null>;
  /** Explicitly materialize a registered workspace runtime; reads stay pure. */
  activateWorkspace?: (
    workspaceId: string,
  ) => ControlPlaneWorkspaceActivationResult | Promise<ControlPlaneWorkspaceActivationResult>;
  /** Workspace attached to the current CLI handoff, if one was supplied. */
  getCurrentWorkspaceId?: () => string | null;
  /** Optional execution adapter for authenticated workspace control routes. */
  execution?: ControlPlaneExecutionSource;
  restart?: () => Promise<ControlPlaneRestartResult> | ControlPlaneRestartResult;
  now?: () => number;
}

/** Sanitized 404 used when a browser selects an unregistered context. */
export class ControlPlaneWorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not-found" as const;

  constructor() {
    super("Workspace is not registered with this daemon host");
    this.name = "ControlPlaneWorkspaceNotFoundError";
  }
}

export interface ControlPlaneRequestObservation {
  durationMs: number;
  method?: string;
  error?: boolean;
  /** A JSON-RPC result with isError=true is an application error. */
  resultError?: boolean;
  /** Optional workspace attribution for context-scoped metrics. */
  workspaceId?: string;
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
  private readonly workspaceMetrics = new Map<string, MetricsAccumulator>();
  private readonly workspaceActivationInFlight = new Map<
    string,
    Promise<ControlPlaneWorkspaceActivationResult>
  >();
  private requestsTotal = 0;
  private errorsTotal = 0;
  private toolCallsTotal = 0;
  private restartInFlight: Promise<ControlPlaneRestartResult> | null = null;
  private readonly executionJobs: ExecutionJobManager;

  constructor(source: ControlPlaneSource) {
    this.source = source;
    this.now = source.now ?? Date.now;
    this.startedAt = this.now();
    this.executionJobs = new ExecutionJobManager({
      onEvent: (event) => {
        const level =
          event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "debug";
        this.recordEvent({
          level,
          type: `execution.${event.status}`,
          message: `Execution job ${event.status}`,
          workspaceId: event.workspaceId,
          metadata: {
            operation: event.operation,
            jobId: event.jobId,
            status: event.status,
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          },
        });
      },
    });
  }

  getWorkspaceExecution(workspaceId: string): ExecutionService | null {
    if (!this.isWorkspaceRegistered(workspaceId)) return null;
    return this.source.execution?.getWorkspaceExecution(workspaceId) ?? null;
  }

  listWorkspaceTools(
    workspaceId: string,
    filter = "",
  ): { tools: ExecutionTool[]; typeDefinitions: string } | null {
    return this.getWorkspaceExecution(workspaceId)?.listTools(filter) ?? null;
  }

  searchWorkspaceTools(workspaceId: string, task: string): ExecutionSearchResult | null {
    return this.getWorkspaceExecution(workspaceId)?.searchTools(task) ?? null;
  }

  queryWorkspaceTools(
    workspaceId: string,
    query: unknown,
    options: ExecutionToolQueryOptions = {},
  ): ToolSearchPage | null {
    return this.getWorkspaceExecution(workspaceId)?.queryTools(query, options) ?? null;
  }

  submitWorkspaceExecution(
    workspaceId: string,
    request: ControlPlaneExecutionRequest,
  ): ExecutionJobSnapshot {
    if (!this.isWorkspaceRegistered(workspaceId)) throw new ControlPlaneWorkspaceNotFoundError();
    const execution = this.getWorkspaceExecution(workspaceId);
    if (!execution) throw new ExecutionError("Workspace runtime is not ready", "not-ready", 409);
    const sessionId = `control:${crypto.randomUUID()}`;
    return this.executionJobs.submit(workspaceId, request.operation, async () => {
      try {
        if (request.operation === "tool-call") {
          return await execution.callTool(sessionId, request.name, request.arguments);
        }
        return await execution.executeCode(sessionId, request.code);
      } finally {
        await execution.cleanupSession(sessionId);
      }
    });
  }

  getWorkspaceJob(workspaceId: string, jobId: string): ExecutionJobSnapshot | null {
    if (!this.isWorkspaceRegistered(workspaceId)) return null;
    return this.executionJobs.get(workspaceId, jobId);
  }

  cancelWorkspaceJob(workspaceId: string, jobId: string): ExecutionJobSnapshot | null {
    if (!this.isWorkspaceRegistered(workspaceId)) return null;
    return this.executionJobs.cancel(workspaceId, jobId);
  }

  getStatus(): ControlPlaneStatus {
    return sanitizeStatus(this.source.getStatus());
  }

  getServers(): ControlPlaneServer[] {
    return sanitizeServers(this.source.getServers());
  }

  /** Workspace selected by the current CLI handoff, or null when unscoped. */
  getCurrentWorkspaceId(): string | null {
    const workspaceId = this.source.getCurrentWorkspaceId?.();
    return workspaceId && isValidWorkspaceId(workspaceId) ? workspaceId : null;
  }

  /** Resolve the management adapter for one workspace without widening scope. */
  getWorkspaceManagement(workspaceId: string): ControlPlaneManagementSource | null {
    if (!isValidWorkspaceId(workspaceId)) return null;
    if (this.source.getWorkspaceManagement) {
      return this.source.getWorkspaceManagement(workspaceId);
    }
    return this.getCurrentWorkspaceId() === workspaceId ? (this.source.management ?? null) : null;
  }

  /** Return whether the host has registered this workspace ID. */
  isWorkspaceRegistered(workspaceId: string): boolean {
    if (!isValidWorkspaceId(workspaceId)) return false;

    const workspaces = this.source.getWorkspaces?.();
    if (workspaces) return workspaces.some((workspace) => workspace.id === workspaceId);

    if (this.source.getWorkspaceStatus) {
      return this.source.getWorkspaceStatus(workspaceId) !== null;
    }

    return this.getCurrentWorkspaceId() === workspaceId;
  }

  async getFeatures(): Promise<ControlPlaneFeatures | null> {
    if (!this.source.management) return null;
    return sanitizeFeatures(await this.source.management.getFeatures());
  }

  async updateServer(
    serverId: string,
    patch: ServerEnabledPatch,
    expectedDigest: string,
  ): Promise<ControlPlaneMutationResult> {
    return this.source.management
      ? this.source.management.updateServer(serverId, patch, expectedDigest)
      : managementUnavailableMutation("Server management is not available for this daemon");
  }

  async updateFeatures(
    patch: Parameters<ControlPlaneManagementSource["updateFeatures"]>[0],
    expectedDigest: string,
  ): Promise<ControlPlaneMutationResult> {
    return this.source.management
      ? this.source.management.updateFeatures(patch, expectedDigest)
      : managementUnavailableMutation("Feature management is not available for this daemon");
  }

  /** Materialize one registered workspace without making status reads lazy writes. */
  async activateWorkspace(workspaceId: string): Promise<ControlPlaneWorkspaceActivationResult> {
    if (!isValidWorkspaceId(workspaceId) || !this.isWorkspaceRegistered(workspaceId)) {
      throw new ControlPlaneWorkspaceNotFoundError();
    }

    const existing = this.workspaceActivationInFlight.get(workspaceId);
    if (existing) return existing;

    const activation = Promise.resolve()
      .then(() =>
        this.source.activateWorkspace
          ? this.source.activateWorkspace(workspaceId)
          : {
              workspaceId,
              state: "error" as const,
              message: "Workspace activation is not available for this daemon",
            },
      )
      .catch((error) => ({
        workspaceId,
        state: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => sanitizeWorkspaceActivationResult(result, workspaceId));
    this.workspaceActivationInFlight.set(workspaceId, activation);
    try {
      return await activation;
    } finally {
      if (this.workspaceActivationInFlight.get(workspaceId) === activation) {
        this.workspaceActivationInFlight.delete(workspaceId);
      }
    }
  }

  /** Return the sanitized server snapshot for a known workspace. */
  getWorkspaceServers(workspaceId: string): ControlPlaneServer[] | null {
    return this.getWorkspaceStatus(workspaceId)?.servers ?? null;
  }

  /** Return the sanitized feature snapshot for a known workspace. */
  async getWorkspaceFeatures(workspaceId: string): Promise<ControlPlaneFeatures | null> {
    if (!isValidWorkspaceId(workspaceId)) return null;

    if (this.source.getWorkspaceFeatures) {
      const features = await this.source.getWorkspaceFeatures(workspaceId);
      if (features) return sanitizeFeatures(features);
    }

    const management = this.getWorkspaceManagement(workspaceId);
    if (management) return sanitizeFeatures(await management.getFeatures());

    return this.getWorkspaceStatus(workspaceId)?.features ?? null;
  }

  /** Return sessions for one registered workspace without falling back to another context. */
  getWorkspaceSessions(workspaceId: string): ControlPlaneSession[] | null {
    if (!this.isWorkspaceRegistered(workspaceId)) return null;
    const sessions = this.source.getWorkspaceSessions?.(workspaceId);
    if (sessions) return sanitizeSessions(sessions);
    return this.getWorkspaceStatus(workspaceId)?.sessions ?? null;
  }

  /** Return metrics for one registered workspace without falling back globally. */
  getWorkspaceMetrics(workspaceId: string): ControlPlaneMetrics | null {
    if (!this.isWorkspaceRegistered(workspaceId)) return null;
    const metrics = this.source.getWorkspaceMetrics?.(workspaceId);
    if (metrics) return sanitizeMetrics(metrics);
    const scoped = this.workspaceMetrics.get(workspaceId);
    if (scoped) return scoped.toMetrics(this.now());
    return this.getWorkspaceStatus(workspaceId)?.metrics ?? null;
  }

  /** Return metrics accumulated for one workspace without invoking source callbacks. */
  getMetricsForWorkspace(workspaceId: string): ControlPlaneMetrics {
    const scoped = this.workspaceMetrics.get(workspaceId);
    return scoped ? scoped.toMetrics(this.now()) : emptyMetrics();
  }

  /** Return activity for one registered workspace with an explicit context boundary. */
  getWorkspaceEvents(
    workspaceId: string,
    limit = CONTROL_PLANE_DEFAULT_EVENT_LIMIT,
  ): ControlPlaneEvent[] | null {
    if (!this.isWorkspaceRegistered(workspaceId)) return null;
    const events = this.source.getWorkspaceEvents?.(workspaceId, boundEventLimit(limit));
    if (events) return sanitizeEvents(events);

    // Legacy event sources may only have a host-wide buffer. Keep events
    // without an explicit workspace attribution out of a context route.
    return this.getEvents(boundEventLimit(limit)).filter(
      (event) => event.workspaceId === workspaceId,
    );
  }

  /** Update one server while keeping the selected workspace as the scope. */
  async updateWorkspaceServer(
    workspaceId: string,
    serverId: string,
    patch: ServerEnabledPatch,
    expectedDigest: string,
  ): Promise<ControlPlaneMutationResult> {
    if (!this.isWorkspaceRegistered(workspaceId)) {
      throw new ControlPlaneWorkspaceNotFoundError();
    }
    const management = this.getWorkspaceManagement(workspaceId);
    return management
      ? management.updateServer(serverId, patch, expectedDigest)
      : managementUnavailableMutation("Server management is not available for this workspace");
  }

  /** Update execution mode while keeping the selected workspace as the scope. */
  async updateWorkspaceFeatures(
    workspaceId: string,
    patch: Parameters<ControlPlaneManagementSource["updateFeatures"]>[0],
    expectedDigest: string,
  ): Promise<ControlPlaneMutationResult> {
    if (!this.isWorkspaceRegistered(workspaceId)) {
      throw new ControlPlaneWorkspaceNotFoundError();
    }
    const management = this.getWorkspaceManagement(workspaceId);
    return management
      ? management.updateFeatures(patch, expectedDigest)
      : managementUnavailableMutation("Feature management is not available for this workspace");
  }

  getSessions(): ControlPlaneSession[] {
    return sanitizeSessions(this.source.getSessions());
  }

  /**
   * Return local workspace records newest/current first. The current marker
   * is derived from the handoff context and is never persisted in the
   * registry, so a browser cannot make an arbitrary directory current by
   * changing its own state.
   */
  getWorkspaces(): ControlPlaneWorkspace[] {
    const currentWorkspaceId = this.getCurrentWorkspaceId();
    const workspaces = this.source.getWorkspaces?.() ?? [];

    return workspaces
      .map((workspace) => sanitizeWorkspace(workspace, workspace.id === currentWorkspaceId))
      .sort(compareWorkspaces);
  }

  /** Return a redacted, context-scoped snapshot for a known workspace. */
  getWorkspaceStatus(workspaceId: string): ControlPlaneWorkspaceStatus | null {
    if (!isValidWorkspaceId(workspaceId)) return null;
    const currentWorkspaceId = this.getCurrentWorkspaceId();
    if (this.source.getWorkspaceStatus) {
      const status = this.source.getWorkspaceStatus(workspaceId);
      if (!status || status.workspace.id !== workspaceId) return null;
      return {
        workspace: sanitizeWorkspace(status.workspace, status.workspace.id === currentWorkspaceId),
        status: sanitizeStatus(status.status),
        servers: sanitizeServers(status.servers),
        sessions: sanitizeSessions(status.sessions),
        metrics: sanitizeMetrics(status.metrics),
        ...(status.features ? { features: sanitizeFeatures(status.features) } : {}),
      };
    }

    const workspace = this.getWorkspaces().find((candidate) => candidate.id === workspaceId);
    if (!workspace) return null;

    // Until isolated contexts are mounted, a non-current workspace is
    // represented explicitly as offline rather than receiving another
    // directory's servers or credentials. This is the safe incremental
    // behavior for clients that discover multiple known directories.
    if (currentWorkspaceId !== workspaceId) {
      const currentStatus = this.getStatus();
      return {
        workspace,
        status: sanitizeStatus({
          ...currentStatus,
          state: "offline",
          profile: workspace.profileId,
          configDigest: workspace.configDigest,
          workspaceId: workspace.id,
          workspaceDirectory: workspace.directory,
          workspaceConfigPath: workspace.configPath,
        }),
        servers: [],
        sessions: [],
        metrics: emptyMetrics(),
      };
    }

    const currentStatus = this.getStatus();
    return {
      workspace,
      status: sanitizeStatus({
        ...currentStatus,
        workspaceId: workspace.id,
        workspaceDirectory: workspace.directory,
        workspaceConfigPath: workspace.configPath,
      }),
      servers: this.getServers(),
      sessions: this.getSessions(),
      metrics: this.getMetrics(),
    };
  }

  /**
   * Return a workspace snapshot after allowing the host to materialize any
   * async config-backed state needed for management reads.
   */
  async getWorkspaceStatusAsync(workspaceId: string): Promise<ControlPlaneWorkspaceStatus | null> {
    if (!isValidWorkspaceId(workspaceId)) return null;

    if (this.source.getWorkspaceStatusAsync) {
      const status = await this.source.getWorkspaceStatusAsync(workspaceId);
      if (!status || status.workspace.id !== workspaceId) return null;
      return {
        workspace: sanitizeWorkspace(
          status.workspace,
          status.workspace.id === this.getCurrentWorkspaceId(),
        ),
        status: sanitizeStatus(status.status),
        servers: sanitizeServers(status.servers),
        sessions: sanitizeSessions(status.sessions),
        metrics: sanitizeMetrics(status.metrics),
        ...(status.features ? { features: sanitizeFeatures(status.features) } : {}),
      };
    }

    return this.getWorkspaceStatus(workspaceId);
  }

  /** Return status plus the workspace's feature snapshot when one is exposed. */
  async getWorkspaceSnapshot(workspaceId: string): Promise<ControlPlaneWorkspaceStatus | null> {
    const status = this.getWorkspaceStatus(workspaceId);
    if (!status) return null;

    const features = await this.getWorkspaceFeatures(workspaceId);
    return features ? { ...status, features } : status;
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

    if (observation.workspaceId && isValidWorkspaceId(observation.workspaceId)) {
      let scoped = this.workspaceMetrics.get(observation.workspaceId);
      if (!scoped) {
        scoped = new MetricsAccumulator(this.now());
        this.workspaceMetrics.set(observation.workspaceId, scoped);
      }
      scoped.record(observation, durationMs);
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
      ...(event.workspaceId && isValidWorkspaceId(event.workspaceId)
        ? { workspaceId: event.workspaceId }
        : {}),
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

class MetricsAccumulator {
  private requestsTotal = 0;
  private errorsTotal = 0;
  private toolCallsTotal = 0;
  private readonly latencySamples: number[] = [];

  constructor(private readonly startedAt: number) {}

  record(observation: ControlPlaneRequestObservation, durationMs: number): void {
    this.requestsTotal += 1;
    if (observation.method === "tools/call") this.toolCallsTotal += 1;
    if (observation.error === true || observation.resultError === true) this.errorsTotal += 1;
    this.latencySamples.push(durationMs);
    if (this.latencySamples.length > CONTROL_PLANE_EVENT_BUFFER_SIZE) this.latencySamples.shift();
  }

  toMetrics(now: number): ControlPlaneMetrics {
    const elapsedSeconds = Math.max((now - this.startedAt) / 1_000, 1);
    return {
      requestsTotal: this.requestsTotal,
      requestsPerSecond: roundMetric(this.requestsTotal / elapsedSeconds),
      errorsTotal: this.errorsTotal,
      errorRate:
        this.requestsTotal === 0 ? 0 : roundMetric((this.errorsTotal / this.requestsTotal) * 100),
      toolCallsTotal: this.toolCallsTotal,
      activeSessions: 0,
      activeLeases: 0,
      latencyMs: {
        p50: percentile(this.latencySamples, 0.5),
        p95: percentile(this.latencySamples, 0.95),
        p99: percentile(this.latencySamples, 0.99),
      },
    };
  }
}

function managementUnavailableMutation(message: string): ControlPlaneMutationResult {
  return {
    accepted: false,
    changed: false,
    mutationId: "",
    configDigest: "",
    previousConfigDigest: "",
    restartState: "failed",
    restart: {
      accepted: false,
      message,
    },
  };
}

function sanitizeStatus(status: ControlPlaneStatus): ControlPlaneStatus {
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
    ...(status.workspaceId ? { workspaceId: sanitizeText(status.workspaceId) } : {}),
    ...(status.workspaceDirectory
      ? { workspaceDirectory: sanitizeText(status.workspaceDirectory) }
      : {}),
    ...(status.workspaceConfigPath
      ? { workspaceConfigPath: sanitizeText(status.workspaceConfigPath) }
      : {}),
    ...(status.pendingRestart === undefined ? {} : { pendingRestart: status.pendingRestart }),
    ...(status.restartState && isRestartState(status.restartState)
      ? { restartState: status.restartState }
      : {}),
    ...(status.restartMessage ? { restartMessage: sanitizeText(status.restartMessage) } : {}),
  };
}

function sanitizeServers(servers: readonly ControlPlaneServer[]): ControlPlaneServer[] {
  return servers.map((server) => {
    const url = server.url ? sanitizeUrl(server.url) : undefined;
    const lastCheckedAt = server.lastCheckedAt ? sanitizeText(server.lastCheckedAt) : undefined;
    const lastError = server.lastError ? sanitizeText(server.lastError) : undefined;

    return {
      id: sanitizeText(server.id),
      name: sanitizeText(server.name),
      ...(server.kind ? { kind: server.kind } : {}),
      ...(url ? { url } : {}),
      ...(server.transport ? { transport: sanitizeText(server.transport) } : {}),
      ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
      ...(server.observedState ? { observedState: server.observedState } : {}),
      ...(server.configRevision ? { configRevision: sanitizeText(server.configRevision) } : {}),
      ...(server.lastChangedAt ? { lastChangedAt: sanitizeText(server.lastChangedAt) } : {}),
      state: server.state,
      toolCount: normalizeCount(server.toolCount),
      ...(isFiniteMetric(server.latencyMs) ? { latencyMs: normalizeMetric(server.latencyMs) } : {}),
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(lastError ? { lastError } : {}),
    };
  });
}

function sanitizeSessions(sessions: readonly ControlPlaneSession[]): ControlPlaneSession[] {
  return sessions.map((session) => ({
    id: sanitizeText(session.id),
    kind: session.kind,
    ...(session.clientName ? { clientName: sanitizeText(session.clientName) } : {}),
    ...(session.clientVersion ? { clientVersion: sanitizeText(session.clientVersion) } : {}),
    ...(session.profile ? { profile: sanitizeText(session.profile) } : {}),
    ...(session.workspaceId ? { workspaceId: sanitizeText(session.workspaceId) } : {}),
    state: session.state,
    connectedAt: sanitizeText(session.connectedAt),
    lastSeenAt: sanitizeText(session.lastSeenAt),
    ...(session.leaseExpiresAt ? { leaseExpiresAt: sanitizeText(session.leaseExpiresAt) } : {}),
  }));
}

function sanitizeMetrics(metrics: ControlPlaneMetrics): ControlPlaneMetrics {
  return {
    requestsTotal: normalizeCount(metrics.requestsTotal),
    requestsPerSecond: normalizeMetric(metrics.requestsPerSecond),
    errorsTotal: normalizeCount(metrics.errorsTotal),
    errorRate: normalizeMetric(metrics.errorRate),
    toolCallsTotal: normalizeCount(metrics.toolCallsTotal),
    activeSessions: normalizeCount(metrics.activeSessions),
    activeLeases: normalizeCount(metrics.activeLeases),
    latencyMs: {
      p50: normalizeMetric(metrics.latencyMs.p50),
      p95: normalizeMetric(metrics.latencyMs.p95),
      p99: normalizeMetric(metrics.latencyMs.p99),
    },
  };
}

function emptyMetrics(): ControlPlaneMetrics {
  return {
    requestsTotal: 0,
    requestsPerSecond: 0,
    errorsTotal: 0,
    errorRate: 0,
    toolCallsTotal: 0,
    activeSessions: 0,
    activeLeases: 0,
    latencyMs: { p50: 0, p95: 0, p99: 0 },
  };
}

function sanitizeWorkspace(
  workspace: ControlPlaneWorkspace,
  current: boolean,
): ControlPlaneWorkspace {
  return {
    id: sanitizeText(workspace.id),
    directory: sanitizeText(workspace.directory),
    configPath: sanitizeText(workspace.configPath),
    configScope: workspace.configScope,
    profileId: sanitizeText(workspace.profileId),
    configDigest: sanitizeText(workspace.configDigest),
    state: current ? "current" : workspace.state,
    activeConnections: normalizeCount(workspace.activeConnections),
    firstSeenAt: sanitizeText(workspace.firstSeenAt),
    lastSeenAt: sanitizeText(workspace.lastSeenAt),
    ...(workspace.lastError ? { lastError: sanitizeText(workspace.lastError) } : {}),
  };
}

function sanitizeWorkspaceActivationResult(
  result: ControlPlaneWorkspaceActivationResult,
  workspaceId: string,
): ControlPlaneWorkspaceActivationResult {
  const state: ControlPlaneWorkspaceActivationState =
    result.state === "ready" || result.state === "initializing" || result.state === "error"
      ? result.state
      : "error";
  return {
    workspaceId,
    state,
    message: sanitizeText(result.message),
  };
}

function compareWorkspaces(left: ControlPlaneWorkspace, right: ControlPlaneWorkspace): number {
  if (left.state === "current" && right.state !== "current") return -1;
  if (left.state !== "current" && right.state === "current") return 1;
  if (left.state === "active" && right.state !== "active") return -1;
  if (left.state !== "active" && right.state === "active") return 1;
  return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
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
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
  };
}

function sanitizeEvents(events: readonly ControlPlaneEvent[]): ControlPlaneEvent[] {
  return events.map((event) => ({
    id: sanitizeText(event.id),
    timestamp: sanitizeText(event.timestamp),
    level: event.level,
    type: sanitizeText(event.type),
    message: sanitizeText(event.message),
    ...(event.workspaceId && isValidWorkspaceId(event.workspaceId)
      ? { workspaceId: event.workspaceId }
      : {}),
    ...(event.metadata ? { metadata: sanitizeMetadata(event.metadata) } : {}),
  }));
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
  let sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }).join("");
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

function sanitizeFeatures(features: ControlPlaneFeatures): ControlPlaneFeatures {
  const mode = isExecutionMode(features.mode) ? features.mode : "standard";
  const effectiveMode = isExecutionMode(features.effectiveMode)
    ? features.effectiveMode
    : "standard";
  const restartState = isRestartState(features.restartState) ? features.restartState : "failed";
  const timeout = Number.isSafeInteger(features.codeMode.timeout)
    ? Math.min(Math.max(features.codeMode.timeout, 1_000), 120_000)
    : 30_000;

  return {
    mode,
    effectiveMode,
    codeMode: {
      timeout,
      allowFetch: features.codeMode.allowFetch === true,
    },
    configDigest: sanitizeText(features.configDigest),
    restartState,
    ...(features.restartId ? { restartId: sanitizeText(features.restartId) } : {}),
    ...(features.restartMessage ? { restartMessage: sanitizeText(features.restartMessage) } : {}),
  };
}

function isExecutionMode(value: string): value is ControlPlaneFeatures["mode"] {
  return value === "standard" || value === "code" || value === "tool-search";
}

function isRestartState(value: string): value is ControlPlaneFeatures["restartState"] {
  return value === "idle" || value === "scheduled" || value === "restarting" || value === "failed";
}

export * from "./pairing.js";
