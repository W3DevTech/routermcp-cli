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

/**
 * Root configuration schema.
 */
export const RouterMcpConfigSchema = z.object({
  mcpServers: z.record(z.string().min(1), ServerConfigSchema).refine(
    (servers) => Object.keys(servers).length > 0,
    { message: "At least one server must be configured" }
  ),
});

export type ValidatedServerConfig = z.infer<typeof ServerConfigSchema>;
export type ValidatedRouterMcpConfig = z.infer<typeof RouterMcpConfigSchema>;
