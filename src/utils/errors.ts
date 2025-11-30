/**
 * Custom error types for RouterMCP CLI
 */

/**
 * Base error class for RouterMCP errors
 */
export class RouterMcpError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "RouterMcpError";
  }
}

/**
 * Error thrown when configuration is invalid or missing
 */
export class ConfigError extends RouterMcpError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "ConfigError";
  }
}

/**
 * Error thrown when upstream server connection fails
 */
export class UpstreamConnectionError extends RouterMcpError {
  constructor(
    public readonly serverName: string,
    message: string,
    cause?: Error,
  ) {
    super(`[${serverName}] ${message}`, cause);
    this.name = "UpstreamConnectionError";
  }
}

/**
 * Error thrown when name collisions are detected
 */
export class CollisionError extends RouterMcpError {
  constructor(
    public readonly collisions: Map<string, string[]>,
    type: "tool" | "resource" | "prompt",
  ) {
    const details = Array.from(collisions.entries())
      .map(([name, sources]) => `  ${name}: ${sources.join(", ")}`)
      .join("\n");
    super(`Name collision detected for ${type}s:\n${details}`);
    this.name = "CollisionError";
  }
}

/**
 * Error thrown when a transport operation fails
 */
export class TransportError extends RouterMcpError {
  constructor(
    public readonly transportType: string,
    message: string,
    cause?: Error,
  ) {
    super(`[${transportType}] ${message}`, cause);
    this.name = "TransportError";
  }
}

/**
 * Error thrown when a gateway operation fails
 */
export class GatewayError extends RouterMcpError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "GatewayError";
  }
}
