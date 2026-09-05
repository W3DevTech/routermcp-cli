import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionTracker,
  DEFAULT_BRIDGE_LEASE_TTL_MS,
} from "../../../src/daemon/connection-tracker.js";

describe("ConnectionTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires a lease with a server-generated id and expiry", () => {
    const tracker = new ConnectionTracker();
    const lease = tracker.acquire();

    expect(lease.leaseId).toMatch(/[0-9a-f-]{36}/);
    expect(lease.connectedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(lease.lastSeenAt).toBe(lease.connectedAt);
    expect(lease.leaseExpiresAt).toBe(
      new Date("2026-01-01T00:00:30.000Z").toISOString(),
    );
    expect(lease.leaseTtlMs).toBe(DEFAULT_BRIDGE_LEASE_TTL_MS);
    expect(tracker.count).toBe(1);
    expect(tracker.has(lease.leaseId)).toBe(true);
    tracker.destroy();
  });

  it("heartbeats a live lease and rejects an expired lease", () => {
    const tracker = new ConnectionTracker(100, undefined, 50);
    const lease = tracker.acquire("bridge-1");

    vi.advanceTimersByTime(25);
    const heartbeat = tracker.heartbeat(lease.leaseId);
    expect(heartbeat).not.toBeNull();
    expect(heartbeat?.lastSeenAt).toBe("2026-01-01T00:00:00.025Z");
    expect(heartbeat?.leaseExpiresAt).toBe("2026-01-01T00:00:00.075Z");

    vi.advanceTimersByTime(50);
    expect(tracker.heartbeat(lease.leaseId)).toBeNull();
    expect(tracker.count).toBe(0);
    tracker.destroy();
  });

  it("releases explicitly and invokes the idle callback after the grace period", () => {
    const onIdle = vi.fn();
    const tracker = new ConnectionTracker(10, onIdle, 1000);
    const lease = tracker.acquire("bridge-1");

    tracker.release(lease.leaseId);
    expect(tracker.count).toBe(0);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(9);
    expect(onIdle).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    tracker.destroy();
  });

  it("keeps multiple leases independent when one expires", () => {
    const tracker = new ConnectionTracker(0, undefined, 25);
    const first = tracker.acquire("bridge-1");
    const second = tracker.acquire("bridge-2");

    vi.advanceTimersByTime(25);
    expect(tracker.has(first.leaseId)).toBe(false);
    expect(tracker.has(second.leaseId)).toBe(false);
    expect(tracker.count).toBe(0);
    tracker.destroy();
  });

  it("validates idle and lease timeout values", () => {
    expect(() => new ConnectionTracker(-1)).toThrow("idle timeout");
    expect(() => new ConnectionTracker(1, undefined, 0)).toThrow("lease TTL");
  });
});
