/**
 * Zod validation schemas for RouterMCP configuration
 */

import { z } from "zod";

/**
 * Schema for server configuration
 */
export const serverConfigSchema = z
  .object({
    transport: z.enum(["stdio", "http-streamable"]),

    // Stdio transport options
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),

    // HTTP transport options
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),

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
  })
  .refine(
    (data) => {
      if (data.transport === "stdio") {
        return !!data.command;
      }
      return true;
    },
    {
      message: "command is required for stdio transport",
      path: ["command"],
    },
  )
  .refine(
    (data) => {
      if (data.transport === "http-streamable") {
        return !!data.url;
      }
      return true;
    },
    {
      message: "url is required for http-streamable transport",
      path: ["url"],
    },
  );

/**
 * Schema for the main RouterMCP configuration
 */
export const routerMcpConfigSchema = z.object({
  mcpServers: z.record(serverConfigSchema),
});

export type ServerConfigSchema = z.infer<typeof serverConfigSchema>;
export type RouterMcpConfigSchema = z.infer<typeof routerMcpConfigSchema>;
