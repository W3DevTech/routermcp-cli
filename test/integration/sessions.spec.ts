import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouterMcpConfig } from "../../src/config/types.js";
import { VirtualSessionManager } from "../../src/core/virtual-session.js";

function createTestConfig(): RouterMcpConfig {
  return {
    mcpServers: {
      test: {
        transport: "stdio",
        command: "echo",
        args: ["test"],
        enabled: true,
      },
    },
  };
}

describe("VirtualSessionManager", () => {
  let sessionManager: VirtualSessionManager;

  beforeEach(() => {
    sessionManager = new VirtualSessionManager({
      config: createTestConfig(),
      sessionTimeout: 1,
      maxSessions: 3,
      verbose: false,
    });
  });

  afterEach(async () => {
    await sessionManager.cleanupAll();
  });

  describe("session creation", () => {
    it("creates a new session", () => {
      const session = sessionManager.getOrCreate("session-1");

      expect(session).toBeDefined();
      expect(session.id).toBe("session-1");
      expect(session.aggregator).toBeDefined();
      expect(session.upstreamManager).toBeDefined();
    });

    it("returns existing session on subsequent calls", () => {
      const session1 = sessionManager.getOrCreate("session-1");
      const session2 = sessionManager.getOrCreate("session-1");

      expect(session1).toBe(session2);
    });

    it("creates different sessions for different IDs", () => {
      const session1 = sessionManager.getOrCreate("session-1");
      const session2 = sessionManager.getOrCreate("session-2");

      expect(session1).not.toBe(session2);
      expect(session1.id).toBe("session-1");
      expect(session2.id).toBe("session-2");
    });

    it("throws when max sessions reached", () => {
      sessionManager.getOrCreate("session-1");
      sessionManager.getOrCreate("session-2");
      sessionManager.getOrCreate("session-3");

      expect(() => sessionManager.getOrCreate("session-4")).toThrow("Maximum sessions (3) reached");
    });

    it("records creation timestamp", () => {
      const before = Date.now();
      const session = sessionManager.getOrCreate("session-1");
      const after = Date.now();

      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(after);
    });
  });

  describe("session retrieval", () => {
    it("gets existing session", () => {
      const created = sessionManager.getOrCreate("session-1");
      const retrieved = sessionManager.get("session-1");

      expect(retrieved).toBe(created);
    });

    it("returns undefined for non-existent session", () => {
      const session = sessionManager.get("non-existent");

      expect(session).toBeUndefined();
    });

    it("has() returns true for existing session", () => {
      sessionManager.getOrCreate("session-1");

      expect(sessionManager.has("session-1")).toBe(true);
    });

    it("has() returns false for non-existent session", () => {
      expect(sessionManager.has("non-existent")).toBe(false);
    });
  });

  describe("session cleanup", () => {
    it("removes session on cleanup", async () => {
      sessionManager.getOrCreate("session-1");

      await sessionManager.cleanup("session-1");

      expect(sessionManager.has("session-1")).toBe(false);
    });

    it("cleanup is idempotent for non-existent sessions", async () => {
      await sessionManager.cleanup("non-existent");
    });

    it("cleanupAll removes all sessions", async () => {
      sessionManager.getOrCreate("session-1");
      sessionManager.getOrCreate("session-2");

      await sessionManager.cleanupAll();

      expect(sessionManager.has("session-1")).toBe(false);
      expect(sessionManager.has("session-2")).toBe(false);
    });
  });

  describe("stats", () => {
    it("returns correct initial stats", () => {
      const stats = sessionManager.getStats();

      expect(stats.activeSessions).toBe(0);
      expect(stats.maxSessions).toBe(3);
    });

    it("updates stats when sessions are created", () => {
      sessionManager.getOrCreate("session-1");
      sessionManager.getOrCreate("session-2");

      const stats = sessionManager.getStats();

      expect(stats.activeSessions).toBe(2);
    });

    it("updates stats when sessions are cleaned up", async () => {
      sessionManager.getOrCreate("session-1");
      sessionManager.getOrCreate("session-2");

      await sessionManager.cleanup("session-1");

      const stats = sessionManager.getStats();

      expect(stats.activeSessions).toBe(1);
    });
  });

  describe("session IDs", () => {
    it("returns empty array when no sessions", () => {
      const ids = sessionManager.getSessionIds();

      expect(ids).toEqual([]);
    });

    it("returns all session IDs", () => {
      sessionManager.getOrCreate("session-1");
      sessionManager.getOrCreate("session-2");

      const ids = sessionManager.getSessionIds();

      expect(ids).toHaveLength(2);
      expect(ids).toContain("session-1");
      expect(ids).toContain("session-2");
    });
  });

  describe("capability cache", () => {
    it("can set capability cache", () => {
      const cachedCapabilities = {
        tools: new Map(),
        resources: new Map(),
        prompts: new Map(),
        serverCapabilities: new Map(),
      };

      sessionManager.setCapabilityCache(cachedCapabilities);

      const session = sessionManager.getOrCreate("session-1");
      expect(session).toBeDefined();
    });
  });

  describe("session timeout", () => {
    it("calls cleanup callback when session times out", async () => {
      const cleanedSessions: string[] = [];
      const manager = new VirtualSessionManager({
        config: createTestConfig(),
        sessionTimeout: 0.1,
        maxSessions: 5,
        verbose: false,
        onSessionCleanup: (sessionId) => {
          cleanedSessions.push(sessionId);
        },
      });

      manager.getOrCreate("timeout-session");

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(cleanedSessions).toContain("timeout-session");
      expect(manager.has("timeout-session")).toBe(false);

      await manager.cleanupAll();
    });

    it("resets timeout on session access", async () => {
      const cleanedSessions: string[] = [];
      const manager = new VirtualSessionManager({
        config: createTestConfig(),
        sessionTimeout: 0.15,
        maxSessions: 5,
        verbose: false,
        onSessionCleanup: (sessionId) => {
          cleanedSessions.push(sessionId);
        },
      });

      manager.getOrCreate("keep-alive-session");

      await new Promise((resolve) => setTimeout(resolve, 100));
      manager.get("keep-alive-session");

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cleanedSessions).not.toContain("keep-alive-session");
      expect(manager.has("keep-alive-session")).toBe(true);

      await manager.cleanupAll();
    });
  });
});
