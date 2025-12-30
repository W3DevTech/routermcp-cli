import { z } from "zod";

/**
 * Schema for stdio transport configuration.
 */
const StdioTransportSchema = z.object({
  transport: z.literal("stdio"),
  enabled: z.boolean().optional().default(true),
  command: z.string().min(1, "Command is required for stdio transport"),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

/**
 * Schema for http-streamable transport configuration.
 */
const HttpTransportSchema = z.object({
  transport: z.literal("http-streamable"),
  enabled: z.boolean().optional().default(true),
  url: z.string().url("Invalid URL for http-streamable transport"),
  headers: z.record(z.string()).optional(),
});

/**
 * Schema for filtering configuration (tools, resources, prompts).
 */
const FilterFieldsSchema = z.object({
  // Tool filtering
  allowedTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
  allowedToolsGlob: z.array(z.string()).optional(),
  denyToolsGlob: z.array(z.string()).optional(),
  // Resource filtering
  allowedResources: z.array(z.string()).optional(),
  denyResources: z.array(z.string()).optional(),
  allowedResourcesGlob: z.array(z.string()).optional(),
  denyResourcesGlob: z.array(z.string()).optional(),
  // Prompt filtering
  allowedPrompts: z.array(z.string()).optional(),
  denyPrompts: z.array(z.string()).optional(),
  allowedPromptsGlob: z.array(z.string()).optional(),
  denyPromptsGlob: z.array(z.string()).optional(),
});

/**
 * Combined server config schema using discriminated union.
 */
export const ServerConfigSchema = z.discriminatedUnion("transport", [
  StdioTransportSchema.merge(FilterFieldsSchema),
  HttpTransportSchema.merge(FilterFieldsSchema),
]);

const HttpServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().optional(),
});

const SessionConfigSchema = z.object({
  timeout: z.number().int().min(1).max(86400).optional().default(300),
  max_sessions: z.number().int().min(1).max(1000).optional().default(25),
});

const CodeModeConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).max(120000).optional().default(30000),
  allowFetch: z.boolean().optional().default(true),
});

export const RouterMcpConfigSchema = z.object({
  mcpServers: z.record(z.string().min(1), ServerConfigSchema).refine(
    (servers) => Object.keys(servers).length > 0,
    { message: "At least one server must be configured" }
  ),
  httpServer: HttpServerConfigSchema.optional(),
  session: SessionConfigSchema.optional(),
  codeMode: CodeModeConfigSchema.optional(),
  subprocess_timeout: z.number().int().min(0).optional().default(180),
  discovery_concurrency: z.number().int().min(1).max(50).optional().default(5),
  connection_timeout: z.number().int().min(1).max(300).optional().default(30),
});

export type ValidatedServerConfig = z.infer<typeof ServerConfigSchema>;
export type ValidatedRouterMcpConfig = z.infer<typeof RouterMcpConfigSchema>;
