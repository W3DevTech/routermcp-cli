/**
 * Transport types supported by MCP servers
 */
export type TransportType = "local" | "http-streamable";

/**
 * Base configuration for MCP server with tool filtering
 */
export interface McpServerToolFilter {
  /** Explicit allow-list of tool names */
  allowedTools?: string[];
  /** Explicit deny-list of tool names */
  denyTools?: string[];
  /** Glob patterns to include tools (e.g., "db:*") */
  allowedToolsGlob?: string[];
  /** Glob patterns to exclude tools */
  denyToolsGlob?: string[];
}

/**
 * Local transport configuration - spawns a process
 */
export interface LocalTransportConfig extends McpServerToolFilter {
  transport: "local";
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
}

/**
 * HTTP Streamable transport configuration
 */
export interface HttpStreamableTransportConfig extends McpServerToolFilter {
  transport: "http-streamable";
  /** URL endpoint for the HTTP streamable server */
  url: string;
  /** Optional headers */
  headers?: Record<string, string>;
}

/**
 * Union type for all MCP server configurations
 */
export type McpServerConfig = LocalTransportConfig | HttpStreamableTransportConfig;

/**
 * Root configuration file structure
 */
export interface RouterMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Tool information from an MCP server
 */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Aggregated tool with source server information
 */
export interface AggregatedTool extends ToolInfo {
  /** The server name this tool belongs to */
  serverName: string;
}

/**
 * Connected MCP server state
 */
export interface ConnectedServer {
  name: string;
  config: McpServerConfig;
  tools: ToolInfo[];
}
