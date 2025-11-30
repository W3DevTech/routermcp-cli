/**
 * Root configuration for RouterMCP.
 */
export interface RouterMcpConfig {
  mcpServers: Record<string, ServerConfig>;
}

/**
 * Configuration for a single upstream MCP server.
 */
export interface ServerConfig {
  /** Transport type */
  transport: "stdio" | "http-streamable";

  /** Whether this server is enabled (default: true) */
  enabled?: boolean;

  // Stdio transport options
  /** Command to execute for stdio transport */
  command?: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the process */
  env?: Record<string, string>;
  /** Working directory for the process */
  cwd?: string;

  // HTTP transport options
  /** URL for http-streamable transport */
  url?: string;
  /** HTTP headers to send with requests */
  headers?: Record<string, string>;

  // Tool filtering
  /** Exact tool names to allow */
  allowedTools?: string[];
  /** Exact tool names to deny */
  denyTools?: string[];
  /** Glob patterns to allow tools */
  allowedToolsGlob?: string[];
  /** Glob patterns to deny tools */
  denyToolsGlob?: string[];

  // Resource filtering
  /** Exact resource URIs to allow */
  allowedResources?: string[];
  /** Exact resource URIs to deny */
  denyResources?: string[];
  /** Glob patterns to allow resources */
  allowedResourcesGlob?: string[];
  /** Glob patterns to deny resources */
  denyResourcesGlob?: string[];

  // Prompt filtering
  /** Exact prompt names to allow */
  allowedPrompts?: string[];
  /** Exact prompt names to deny */
  denyPrompts?: string[];
  /** Glob patterns to allow prompts */
  allowedPromptsGlob?: string[];
  /** Glob patterns to deny prompts */
  denyPromptsGlob?: string[];
}

/**
 * Filter configuration extracted from ServerConfig.
 */
export interface FilterConfig {
  allowed?: string[];
  deny?: string[];
  allowedGlob?: string[];
  denyGlob?: string[];
}

/**
 * CLI options for the serve command.
 */
export interface ServeOptions {
  config: string;
  stdio: boolean;
  http?: number;
  verbose: boolean;
}
