import { describe, it, expect } from "vitest";
import {
  RouterMcpError,
  ConfigError,
  CollisionError,
  UpstreamError,
  TransportError,
  ProxyChildProcessError,
  ProxySessionError,
} from "../../../src/utils/errors";

describe("utils/errors", () => {
  describe("RouterMcpError", () => {
    it("creates error with message and code", () => {
      const error = new RouterMcpError("test message", "TEST_CODE");
      expect(error.message).toBe("test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.name).toBe("RouterMcpError");
      expect(error.cause).toBeUndefined();
    });

    it("creates error with cause", () => {
      const cause = new Error("original error");
      const error = new RouterMcpError("wrapped", "WRAP_CODE", cause);
      expect(error.cause).toBe(cause);
    });

    it("is instanceof Error", () => {
      const error = new RouterMcpError("test", "CODE");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });

  describe("ConfigError", () => {
    it("creates config error with proper code", () => {
      const error = new ConfigError("invalid config");
      expect(error.message).toBe("invalid config");
      expect(error.code).toBe("CONFIG_ERROR");
      expect(error.name).toBe("ConfigError");
    });

    it("preserves cause", () => {
      const cause = new Error("parse failed");
      const error = new ConfigError("config parse error", cause);
      expect(error.cause).toBe(cause);
    });

    it("is instanceof RouterMcpError", () => {
      const error = new ConfigError("test");
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });

  describe("CollisionError", () => {
    it("creates collision error with single collision", () => {
      const collisions = [{ name: "read_file", type: "tool" as const, servers: ["fs1", "fs2"] }];
      const error = new CollisionError(collisions);
      expect(error.message).toBe('Name collisions detected: tool "read_file" in [fs1, fs2]');
      expect(error.code).toBe("COLLISION_ERROR");
      expect(error.name).toBe("CollisionError");
      expect(error.collisions).toBe(collisions);
    });

    it("creates collision error with multiple collisions", () => {
      const collisions = [
        { name: "read_file", type: "tool" as const, servers: ["fs1", "fs2"] },
        { name: "config://db", type: "resource" as const, servers: ["db1", "db2", "db3"] },
        { name: "help", type: "prompt" as const, servers: ["a", "b"] },
      ];
      const error = new CollisionError(collisions);
      expect(error.message).toBe(
        'Name collisions detected: tool "read_file" in [fs1, fs2]; resource "config://db" in [db1, db2, db3]; prompt "help" in [a, b]',
      );
      expect(error.collisions).toHaveLength(3);
    });

    it("is instanceof RouterMcpError", () => {
      const error = new CollisionError([]);
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });

  describe("UpstreamError", () => {
    it("creates upstream error with server name", () => {
      const error = new UpstreamError("github", "connection refused");
      expect(error.message).toBe("[github] connection refused");
      expect(error.code).toBe("UPSTREAM_ERROR");
      expect(error.name).toBe("UpstreamError");
      expect(error.serverName).toBe("github");
    });

    it("preserves cause", () => {
      const cause = new Error("ECONNREFUSED");
      const error = new UpstreamError("api", "failed to connect", cause);
      expect(error.cause).toBe(cause);
    });

    it("is instanceof RouterMcpError", () => {
      const error = new UpstreamError("test", "error");
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });

  describe("TransportError", () => {
    it("creates transport error with transport type", () => {
      const error = new TransportError("stdio", "pipe broken");
      expect(error.message).toBe("[stdio] pipe broken");
      expect(error.code).toBe("TRANSPORT_ERROR");
      expect(error.name).toBe("TransportError");
      expect(error.transportType).toBe("stdio");
    });

    it("creates transport error for http-streamable", () => {
      const error = new TransportError("http-streamable", "connection timeout");
      expect(error.message).toBe("[http-streamable] connection timeout");
      expect(error.transportType).toBe("http-streamable");
    });

    it("preserves cause", () => {
      const cause = new Error("socket hangup");
      const error = new TransportError("http", "request failed", cause);
      expect(error.cause).toBe(cause);
    });

    it("is instanceof RouterMcpError", () => {
      const error = new TransportError("test", "error");
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });

  describe("ProxyChildProcessError", () => {
    it("creates error with command and restart count", () => {
      const error = new ProxyChildProcessError("npx mcp-server", 3, "process exited with code 1");
      expect(error.message).toBe(
        "Child process failed after 3 restart(s): process exited with code 1",
      );
      expect(error.code).toBe("PROXY_CHILD_PROCESS_ERROR");
      expect(error.name).toBe("ProxyChildProcessError");
      expect(error.command).toBe("npx mcp-server");
      expect(error.restartCount).toBe(3);
    });

    it("handles zero restart count", () => {
      const error = new ProxyChildProcessError("node server.js", 0, "failed to spawn");
      expect(error.message).toBe("Child process failed after 0 restart(s): failed to spawn");
      expect(error.restartCount).toBe(0);
    });

    it("preserves cause", () => {
      const cause = new Error("ENOENT");
      const error = new ProxyChildProcessError("missing-binary", 1, "command not found", cause);
      expect(error.cause).toBe(cause);
    });

    it("is instanceof RouterMcpError", () => {
      const error = new ProxyChildProcessError("cmd", 0, "error");
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });

  describe("ProxySessionError", () => {
    it("creates error with session ID", () => {
      const error = new ProxySessionError("sess_123", "session expired");
      expect(error.message).toBe("[session: sess_123] session expired");
      expect(error.code).toBe("PROXY_SESSION_ERROR");
      expect(error.name).toBe("ProxySessionError");
      expect(error.sessionId).toBe("sess_123");
    });

    it("creates error without session ID", () => {
      const error = new ProxySessionError(undefined, "no session provided");
      expect(error.message).toBe("[no session] no session provided");
      expect(error.sessionId).toBeUndefined();
    });

    it("preserves cause", () => {
      const cause = new Error("timeout");
      const error = new ProxySessionError("sess_456", "request timeout", cause);
      expect(error.cause).toBe(cause);
    });

    it("is instanceof RouterMcpError", () => {
      const error = new ProxySessionError("id", "error");
      expect(error).toBeInstanceOf(RouterMcpError);
    });
  });
});
