/**
 * Base error class for RouterMCP errors.
 */
export class RouterMcpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "RouterMcpError";
  }
}

/**
 * Configuration-related errors.
 */
export class ConfigError extends RouterMcpError {
  constructor(message: string, cause?: Error) {
    super(message, "CONFIG_ERROR", cause);
    this.name = "ConfigError";
  }
}

/**
 * Tool/resource/prompt name collision error.
 */
export class CollisionError extends RouterMcpError {
  constructor(
    public readonly collisions: Array<{
      name: string;
      type: "tool" | "resource" | "prompt";
      servers: string[];
    }>,
  ) {
    const msg = collisions
      .map((c) => `${c.type} "${c.name}" in [${c.servers.join(", ")}]`)
      .join("; ");
    super(`Name collisions detected: ${msg}`, "COLLISION_ERROR");
    this.name = "CollisionError";
  }
}

/**
 * Upstream server connection error.
 */
export class UpstreamError extends RouterMcpError {
  constructor(
    public readonly serverName: string,
    message: string,
    cause?: Error,
  ) {
    super(`[${serverName}] ${message}`, "UPSTREAM_ERROR", cause);
    this.name = "UpstreamError";
  }
}

/**
 * Transport-related error.
 */
export class TransportError extends RouterMcpError {
  constructor(
    public readonly transportType: string,
    message: string,
    cause?: Error,
  ) {
    super(`[${transportType}] ${message}`, "TRANSPORT_ERROR", cause);
    this.name = "TransportError";
  }
}

/**
 * Proxy child process error - thrown when child process fails to start or crashes repeatedly.
 */
export class ProxyChildProcessError extends RouterMcpError {
  constructor(
    public readonly command: string,
    public readonly restartCount: number,
    message: string,
    cause?: Error,
  ) {
    super(
      `Child process failed after ${restartCount} restart(s): ${message}`,
      "PROXY_CHILD_PROCESS_ERROR",
      cause,
    );
    this.name = "ProxyChildProcessError";
  }
}

/**
 * Proxy session error - thrown for session-related issues.
 */
export class ProxySessionError extends RouterMcpError {
  constructor(
    public readonly sessionId: string | undefined,
    message: string,
    cause?: Error,
  ) {
    const sessionInfo = sessionId ? `[session: ${sessionId}]` : "[no session]";
    super(`${sessionInfo} ${message}`, "PROXY_SESSION_ERROR", cause);
    this.name = "ProxySessionError";
  }
}
