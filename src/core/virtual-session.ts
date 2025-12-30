import type { RouterMcpConfig } from "../config/types.js";
import { UpstreamManager, type ServerCapabilityCache } from "./upstream.js";
import {
  Aggregator,
  type ToolWithSource,
  type ResourceWithSource,
  type PromptWithSource,
} from "./aggregator.js";
import { SessionAccessCounter } from "./session-counter.js";

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
}

export interface VirtualSessionManagerOptions {
  config: RouterMcpConfig;
  sessionTimeout: number;
  maxSessions: number;
  verbose?: boolean;
  onSessionCleanup?: (sessionId: string) => void;
}

export class VirtualSessionManager {
  private sessions: Map<string, VirtualSession> = new Map();
  private sessionCounter: SessionAccessCounter;
  private config: RouterMcpConfig;
  private cachedCapabilities: CachedCapabilities | null = null;
  private maxSessions: number;
  private verbose: boolean;

  constructor(options: VirtualSessionManagerOptions) {
    this.config = options.config;
    this.maxSessions = options.maxSessions;
    this.verbose = options.verbose ?? false;

    this.sessionCounter = new SessionAccessCounter(
      options.sessionTimeout * 1000,
      (sessionId) => {
        this.log(`Session ${sessionId} timed out`);
        this.cleanup(sessionId);
        options.onSessionCleanup?.(sessionId);
      }
    );
  }

  setCapabilityCache(capabilities: CachedCapabilities): void {
    this.cachedCapabilities = capabilities;
  }

  getOrCreate(sessionId: string): VirtualSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.sessionCounter.access(sessionId);
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Maximum sessions (${this.maxSessions}) reached. Try again later.`
      );
    }

    this.log(`Creating new session: ${sessionId}`);

    const upstreamManager = new UpstreamManager(
      this.config,
      this.verbose,
      this.cachedCapabilities?.serverCapabilities
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

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[session-manager] ${message}`);
    }
  }
}
