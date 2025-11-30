/**
 * Base error class for RouterMCP errors.
 */
export class RouterMcpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
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
    }>
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
    cause?: Error
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
    cause?: Error
  ) {
    super(`[${transportType}] ${message}`, "TRANSPORT_ERROR", cause);
    this.name = "TransportError";
  }
}
