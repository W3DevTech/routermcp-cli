import { randomUUID } from "node:crypto";

export const DEFAULT_BRIDGE_LEASE_TTL_MS = 30_000;
export const DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 10_000;

export interface ConnectionLease {
  leaseId: string;
  connectedAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string;
  leaseTtlMs: number;
}

interface TrackedConnection {
  lease: ConnectionLease;
  expiryTimer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks short-lived bridge leases independently from MCP sessions.
 *
 * A bridge can disappear without sending a final request, so each lease has
 * an expiry and must be heartbeated. Explicit release remains the fast path;
 * expiry is the crash-safe fallback. The idle callback is retained for the
 * daemon supervisor's future idle-shutdown policy.
 */
export class ConnectionTracker {
  private connections = new Map<string, TrackedConnection>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeout: number;
  private readonly leaseTtlMs: number;
  private readonly onIdle: () => void;

  constructor(
    idleTimeout: number = DEFAULT_CONNECTION_IDLE_TIMEOUT_MS,
    onIdle: () => void = () => undefined,
    leaseTtlMs: number = DEFAULT_BRIDGE_LEASE_TTL_MS,
  ) {
    if (!Number.isFinite(idleTimeout) || idleTimeout < 0) {
      throw new Error("Connection idle timeout must be a non-negative number");
    }
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new Error("Bridge lease TTL must be a positive number");
    }

    this.idleTimeout = idleTimeout;
    this.leaseTtlMs = leaseTtlMs;
    this.onIdle = onIdle;
  }

  /** Acquire a server-generated lease for one stdio bridge. */
  acquire(connectionId: string = randomUUID()): ConnectionLease {
    const existing = this.connections.get(connectionId);
    if (existing) {
      return this.heartbeat(connectionId) ?? existing.lease;
    }

    const now = new Date();
    const lease = createLease(connectionId, now, this.leaseTtlMs);
    const tracked: TrackedConnection = {
      lease,
      expiryTimer: this.createExpiryTimer(connectionId, this.leaseTtlMs),
    };
    this.connections.set(connectionId, tracked);
    this.clearIdleTimer();
    return lease;
  }

  /**
   * Backwards-compatible alias for callers that only need to mark a
   * connection active. New bridge code should use acquire().
   */
  add(connectionId: string): void {
    this.acquire(connectionId);
  }

  /** Extend a live lease, returning its public snapshot. */
  heartbeat(connectionId: string): ConnectionLease | null {
    const tracked = this.connections.get(connectionId);
    if (!tracked) return null;

    clearTimeout(tracked.expiryTimer);
    const now = new Date();
    tracked.lease = {
      ...tracked.lease,
      lastSeenAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
    };
    tracked.expiryTimer = this.createExpiryTimer(connectionId, this.leaseTtlMs);
    return tracked.lease;
  }

  /** Release one bridge lease. Releasing an unknown lease is idempotent. */
  remove(connectionId: string): void {
    const tracked = this.connections.get(connectionId);
    if (!tracked) return;

    clearTimeout(tracked.expiryTimer);
    this.connections.delete(connectionId);
    if (this.connections.size === 0) {
      this.startIdleTimer();
    }
  }

  release(connectionId: string): void {
    this.remove(connectionId);
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  get count(): number {
    return this.connections.size;
  }

  get leases(): ConnectionLease[] {
    return Array.from(this.connections.values(), ({ lease }) => ({ ...lease }));
  }

  destroy(): void {
    this.clearIdleTimer();
    for (const { expiryTimer } of this.connections.values()) {
      clearTimeout(expiryTimer);
    }
    this.connections.clear();
  }

  private createExpiryTimer(connectionId: string, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const tracked = this.connections.get(connectionId);
      if (!tracked) return;

      const remaining = Date.parse(tracked.lease.leaseExpiresAt) - Date.now();
      if (remaining > 0) {
        tracked.expiryTimer = this.createExpiryTimer(connectionId, remaining);
        return;
      }

      this.connections.delete(connectionId);
      if (this.connections.size === 0) {
        this.startIdleTimer();
      }
    }, delayMs);
    timer.unref?.();
    return timer;
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeout === 0) {
      this.onIdle();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.connections.size === 0) {
        this.onIdle();
      }
    }, this.idleTimeout);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function createLease(connectionId: string, now: Date, leaseTtlMs: number): ConnectionLease {
  const timestamp = now.toISOString();
  return {
    leaseId: connectionId,
    connectedAt: timestamp,
    lastSeenAt: timestamp,
    leaseExpiresAt: new Date(now.getTime() + leaseTtlMs).toISOString(),
    leaseTtlMs,
  };
}
