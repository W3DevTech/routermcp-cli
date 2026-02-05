export interface HttpServerConfig {
  port?: number;
  host?: string;
}

/**
 * Configuration scope for multi-level config support.
 * - project-local: ./routermcp.jsonc (highest priority)
 * - user-project: ~/.config/routermcp/projects/<projectId>/routermcp.jsonc
 * - user-global: ~/.config/routermcp/routermcp.jsonc (lowest priority)
 */
export type ConfigScope = "project-local" | "user-project" | "user-global";

/**
 * Represents a config file location with its scope and existence status.
 */
export interface ConfigLocation {
  path: string;
  scope: ConfigScope;
  exists: boolean;
}

/**
 * Result of resolving configuration across all scopes.
 */
export interface ResolvedConfig {
  config: RouterMcpConfig;
  path: string;
  scope: ConfigScope;
}

/**
 * Authentication configuration for OpenAPI servers.
 * Independent of security schemes defined in the OpenAPI spec itself.
 */
export interface OpenApiAuthConfig {
  /** Authentication type */
  type: "bearer" | "api-key" | "basic";

  /** Bearer token (for type: "bearer") */
  token?: string;

  /** Header name for API key (for type: "api-key") */
  header?: string;
  /** API key value (for type: "api-key") */
  value?: string;

  /** Username (for type: "basic") */
  username?: string;
  /** Password (for type: "basic") */
  password?: string;
}

/**
 * Configuration for a single OpenAPI server.
 * OpenAPI specs are converted to MCP tools at startup.
 */
export interface OpenApiServerConfig {
  /** OpenAPI spec source - URL, file path, or inline object */
  spec: string | Record<string, unknown>;

  /** Base URL for API requests (overrides spec's servers[0].url) */
  baseUrl?: string;

  /** Authentication configuration (independent of OpenAPI security schemes) */
  auth?: OpenApiAuthConfig;

  /** Whether this server is enabled (default: true) */
  enabled?: boolean;

  // Tool filtering (applied to prefixed tool names like "petstore_getPetById")
  /** Exact tool names to allow */
  allowedTools?: string[];
  /** Exact tool names to deny */
  denyTools?: string[];
  /** Glob patterns to allow tools */
  allowedToolsGlob?: string[];
  /** Glob patterns to deny tools */
  denyToolsGlob?: string[];
}

export interface OAuthConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  clientName?: string;
}

/**
 * Root configuration for RouterMCP.
 */
export interface SessionConfig {
  timeout?: number;
  max_sessions?: number;
}

/**
 * Code Mode configuration.
 * When enabled, exposes meta-tools (listTools, executeCode) instead of raw tools.
 */
export interface CodeModeConfig {
  /** Enable Code Mode (default: false) */
  enabled?: boolean;
  /** Execution timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Allow fetch() in sandbox (default: true) */
  allowFetch?: boolean;
}

/**
 * MCP Tool Search configuration.
 * When enabled, exposes meta-tools (searchMcpForTask, callTool) for intelligent tool discovery.
 * Mutually exclusive with Code Mode.
 */
export interface McpToolSearchConfig {
  /** Enable Tool Search mode (default: false) */
  enabled?: boolean;
  /** Custom description for the searchMcpForTask tool */
  description?: string;
  /** Maximum number of search results to return (default: 5, max: 50) */
  maxResults?: number;
  /** Minimum relevance score threshold (default: 0, range: 0-1) */
  minScore?: number;
}

export interface RouterMcpConfig {
  mcpServers: Record<string, ServerConfig>;
  openApiServers?: Record<string, OpenApiServerConfig>;
  httpServer?: HttpServerConfig;
  session?: SessionConfig;
  codeMode?: CodeModeConfig;
  mcpToolSearch?: McpToolSearchConfig;

  subprocess_timeout?: number;
  discovery_concurrency?: number;
  connection_timeout?: number;

  /**
   * Strict environment variable mode.
   * When true, throws an error if any ${env:VAR} reference cannot be resolved.
   * When false (default), unresolved ${env:VAR} references are left unexpanded with a warning.
   */
  strictEnvVars?: boolean;
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

  url?: string;
  headers?: Record<string, string>;
  oauth?: OAuthConfig;

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
