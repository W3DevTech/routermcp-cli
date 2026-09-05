import type { RouterMcpConfig } from "../config/types.js";
import type { RuntimeExecutionContext } from "./execution-context.js";
import {
  Aggregator,
  type PromptWithSource,
  type ResourceWithSource,
  type ToolWithSource,
} from "./aggregator.js";
import { SessionAccessCounter } from "./session-counter.js";
import {
  type ServerCapabilityCache,
  type UpstreamServer,
  UpstreamManager,
} from "./upstream.js";

export interface CachedCapabilities {
  tools: Map<string, ToolWithSource>;
  resources: Map<string, ResourceWithSource>;
  prompts: Map<string, PromptWithSource>;
  serverCapabilities: Map<string, ServerCapabilityCache>;
}

export interface VirtualSession {
  id: string;
  upstreamManager: UpstreamManager;
  aggregator: Aggregator;
  createdAt: number;
  clientInfo?: VirtualSessionClientInfo;
}

export interface VirtualSessionClientInfo {
  name: string;
  version?: string;
}

export type VirtualSessionSnapshotState = "active" | "idle" | "expired";

export interface VirtualSessionSnapshot {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  state: VirtualSessionSnapshotState;
  clientName?: string;
  clientVersion?: string;
}

export interface VirtualSessionManagerOptions {
  config: RouterMcpConfig;
  sessionTimeout: number;
  maxSessions: number;
  verbose?: boolean;
  executionContext?: RuntimeExecutionContext;
  onSessionCleanup?: (sessionId: string) => void;
}

export class VirtualSessionManager {
  private sessions: Map<string, VirtualSession> = new Map();
  private sessionCounter: SessionAccessCounter;
  private config: RouterMcpConfig;
  private cachedCapabilities: CachedCapabilities | null = null;
  private maxSessions: number;
  private verbose: boolean;
  private readonly executionContext?: RuntimeExecutionContext;
  private readonly sessionTimeoutMs: number;

  constructor(options: VirtualSessionManagerOptions) {
    this.config = options.config;
    this.maxSessions = options.maxSessions;
    this.verbose = options.verbose ?? false;
    this.executionContext = options.executionContext;
    this.sessionTimeoutMs = Math.max(0, options.sessionTimeout * 1000);

    this.sessionCounter = new SessionAccessCounter(options.sessionTimeout * 1000, (sessionId) => {
      this.log(`Session ${sessionId} timed out`);
      void this.cleanup(sessionId);
      options.onSessionCleanup?.(sessionId);
    });
  }

  setCapabilityCache(capabilities: CachedCapabilities): void {
    this.cachedCapabilities = capabilities;
  }

  getOrCreate(sessionId: string, clientInfo?: VirtualSessionClientInfo): VirtualSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (clientInfo) {
        existing.clientInfo = clientInfo;
      }
      this.sessionCounter.access(sessionId);
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum sessions (${this.maxSessions}) reached. Try again later.`);
    }

    this.log(`Creating new session: ${sessionId}`);

    const upstreamManager = new UpstreamManager(
      this.config,
      this.verbose,
      this.cachedCapabilities?.serverCapabilities,
      this.executionContext,
    );

    const aggregator = new Aggregator(upstreamManager);

    if (this.cachedCapabilities) {
      aggregator.initializeFromCache({
        tools: this.cachedCapabilities.tools,
        resources: this.cachedCapabilities.resources,
        prompts: this.cachedCapabilities.prompts,
      });
    }

    const session: VirtualSession = {
      id: sessionId,
      upstreamManager,
      aggregator,
      createdAt: Date.now(),
      ...(clientInfo ? { clientInfo } : {}),
    };

    this.sessions.set(sessionId, session);
    this.sessionCounter.access(sessionId);

    return session;
  }

  get(sessionId: string): VirtualSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessionCounter.access(sessionId);
    }
    return session;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async cleanup(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.log(`Cleaning up session: ${sessionId}`);

    await session.upstreamManager.disconnectAll();
    this.sessions.delete(sessionId);
    this.sessionCounter.remove(sessionId);
  }

  async cleanupAll(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    for (const sessionId of this.sessions.keys()) {
      cleanupPromises.push(this.cleanup(sessionId));
    }

    await Promise.allSettled(cleanupPromises);
    this.sessionCounter.destroy();
  }

  getStats(): { activeSessions: number; maxSessions: number } {
    return {
      activeSessions: this.sessions.size,
      maxSessions: this.maxSessions,
    };
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Return the upstream records owned by active virtual sessions. The
   * gateway combines these with its discovery snapshot for management views
   * so on-demand connection failures are not hidden by the shared cache.
   */
  getUpstreamServers(): UpstreamServer[] {
    return Array.from(this.sessions.values()).flatMap((session) => session.upstreamManager.getAll());
  }

  /**
   * Return the small, browser-safe portion of session state needed by the
   * management API. Upstream clients and aggregators are intentionally not
   * exposed to callers taking a snapshot.
   */
  getSnapshots(now = Date.now()): VirtualSessionSnapshot[] {
    return Array.from(this.sessions.values(), (session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: this.sessionCounter.getLastAccess(session.id) ?? session.createdAt,
      state: getSessionSnapshotState(
        now,
        this.sessionCounter.getLastAccess(session.id) ?? session.createdAt,
        this.sessionTimeoutMs,
      ),
      ...(session.clientInfo?.name ? { clientName: session.clientInfo.name } : {}),
      ...(session.clientInfo?.version ? { clientVersion: session.clientInfo.version } : {}),
    }));
  }

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[session-manager] ${message}`);
    }
  }
}

function getSessionSnapshotState(
  now: number,
  lastSeenAt: number,
  timeoutMs: number,
): VirtualSessionSnapshotState {
  const ageMs = Math.max(0, now - lastSeenAt);
  if (ageMs >= timeoutMs) return "expired";
  if (ageMs >= timeoutMs / 2) return "idle";
  return "active";
}
