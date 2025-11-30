/**
 * RouterMCP CLI Configuration Types
 */

/**
 * Main configuration interface for RouterMCP
 */
export interface RouterMcpConfig {
  mcpServers: Record<string, ServerConfig>;
}

/**
 * Configuration for an individual upstream MCP server
 */
export interface ServerConfig {
  /**
   * Transport type for connecting to the upstream server
   */
  transport: "stdio" | "http-streamable";

  // Stdio transport options
  /**
   * Command to execute for stdio transport
   */
  command?: string;
  /**
   * Arguments to pass to the command
   */
  args?: string[];
  /**
   * Environment variables to set for the command
   */
  env?: Record<string, string>;

  // HTTP transport options
  /**
   * URL for HTTP streamable transport
   */
  url?: string;
  /**
   * Headers to include in HTTP requests (supports ${ENV_VAR} substitution)
   */
  headers?: Record<string, string>;

  // Tool filtering
  /**
   * Explicit list of allowed tool names
   */
  allowedTools?: string[];
  /**
   * Explicit list of denied tool names
   */
  denyTools?: string[];
  /**
   * Glob patterns for allowed tools
   */
  allowedToolsGlob?: string[];
  /**
   * Glob patterns for denied tools
   */
  denyToolsGlob?: string[];

  // Resource filtering
  /**
   * Explicit list of allowed resource URIs
   */
  allowedResources?: string[];
  /**
   * Explicit list of denied resource URIs
   */
  denyResources?: string[];
  /**
   * Glob patterns for allowed resources
   */
  allowedResourcesGlob?: string[];
  /**
   * Glob patterns for denied resources
   */
  denyResourcesGlob?: string[];

  // Prompt filtering
  /**
   * Explicit list of allowed prompt names
   */
  allowedPrompts?: string[];
  /**
   * Explicit list of denied prompt names
   */
  denyPrompts?: string[];
  /**
   * Glob patterns for allowed prompts
   */
  allowedPromptsGlob?: string[];
  /**
   * Glob patterns for denied prompts
   */
  denyPromptsGlob?: string[];
}

/**
 * Filter configuration for a capability type (tools, resources, prompts)
 */
export interface FilterConfig {
  allowed?: string[];
  deny?: string[];
  allowedGlob?: string[];
  denyGlob?: string[];
}
