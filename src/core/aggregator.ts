import type { Tool, Resource, Prompt, CallToolResult, ReadResourceResult, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamManager, UpstreamServer } from "./upstream.js";
import type { ServerConfig } from "../config/types.js";
import {
  shouldAllow,
  getToolFilter,
  getResourceFilter,
  getPromptFilter,
} from "../filtering/filter.js";
import { checkAllCollisions, type ItemWithSource } from "../filtering/collision.js";
import { UpstreamError } from "../utils/errors.js";

/**
 * Tool with source server information.
 */
export interface ToolWithSource {
  tool: Tool;
  serverName: string;
}

/**
 * Resource with source server information.
 */
export interface ResourceWithSource {
  resource: Resource;
  serverName: string;
}

/**
 * Prompt with source server information.
 */
export interface PromptWithSource {
  prompt: Prompt;
  serverName: string;
}

/**
 * Aggregator for tools, resources, and prompts from multiple upstream servers.
 */
export class Aggregator {
  private upstreamManager: UpstreamManager;

  private toolsMap: Map<string, ToolWithSource> = new Map();
  private resourcesMap: Map<string, ResourceWithSource> = new Map();
  private promptsMap: Map<string, PromptWithSource> = new Map();

  constructor(upstreamManager: UpstreamManager) {
    this.upstreamManager = upstreamManager;
  }

  /**
   * Refresh and aggregate all capabilities from connected servers.
   * Applies filtering and checks for collisions.
   */
  refresh(): void {
    this.toolsMap.clear();
    this.resourcesMap.clear();
    this.promptsMap.clear();

    const allTools: ItemWithSource[] = [];
    const allResources: ItemWithSource[] = [];
    const allPrompts: ItemWithSource[] = [];

    for (const server of this.upstreamManager.getConnected()) {
      // Filter and collect tools
      const toolFilter = getToolFilter(server.config);
      for (const tool of server.tools) {
        if (shouldAllow(tool.name, toolFilter)) {
          allTools.push({ name: tool.name, serverName: server.name });
          this.toolsMap.set(tool.name, { tool, serverName: server.name });
        }
      }

      // Filter and collect resources
      const resourceFilter = getResourceFilter(server.config);
      for (const resource of server.resources) {
        if (shouldAllow(resource.uri, resourceFilter)) {
          allResources.push({ name: resource.uri, serverName: server.name });
          this.resourcesMap.set(resource.uri, { resource, serverName: server.name });
        }
      }

      // Filter and collect prompts
      const promptFilter = getPromptFilter(server.config);
      for (const prompt of server.prompts) {
        if (shouldAllow(prompt.name, promptFilter)) {
          allPrompts.push({ name: prompt.name, serverName: server.name });
          this.promptsMap.set(prompt.name, { prompt, serverName: server.name });
        }
      }
    }

    // Check for collisions (throws if found)
    checkAllCollisions({
      tools: allTools,
      resources: allResources,
      prompts: allPrompts,
    });
  }

  /**
   * Get all aggregated tools.
   */
  getTools(): Tool[] {
    return Array.from(this.toolsMap.values()).map((t) => t.tool);
  }

  /**
   * Get all aggregated resources.
   */
  getResources(): Resource[] {
    return Array.from(this.resourcesMap.values()).map((r) => r.resource);
  }

  /**
   * Get all aggregated prompts.
   */
  getPrompts(): Prompt[] {
    return Array.from(this.promptsMap.values()).map((p) => p.prompt);
  }

  /**
   * Route a tool call to the appropriate upstream server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const entry = this.toolsMap.get(name);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

    const client = this.upstreamManager.getClient(entry.serverName);
    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: `Server "${entry.serverName}" is not connected`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await client.callTool({ name, arguments: args });
      // Cast to CallToolResult - the SDK returns this type
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Tool call failed: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Route a resource read to the appropriate upstream server.
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    const entry = this.resourcesMap.get(uri);
    if (!entry) {
      throw new UpstreamError("unknown", `Resource not found: ${uri}`);
    }

    const client = this.upstreamManager.getClient(entry.serverName);
    if (!client) {
      throw new UpstreamError(
        entry.serverName,
        `Server is not connected`
      );
    }

    return client.readResource({ uri });
  }

  /**
   * Route a prompt get to the appropriate upstream server.
   */
  async getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<GetPromptResult> {
    const entry = this.promptsMap.get(name);
    if (!entry) {
      throw new UpstreamError("unknown", `Prompt not found: ${name}`);
    }

    const client = this.upstreamManager.getClient(entry.serverName);
    if (!client) {
      throw new UpstreamError(
        entry.serverName,
        `Server is not connected`
      );
    }

    return client.getPrompt({ name, arguments: args });
  }

  /**
   * Get stats about aggregated capabilities.
   */
  getStats(): { tools: number; resources: number; prompts: number } {
    return {
      tools: this.toolsMap.size,
      resources: this.resourcesMap.size,
      prompts: this.promptsMap.size,
    };
  }
}
