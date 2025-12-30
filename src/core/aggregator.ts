import type {
  Tool,
  Resource,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamManager } from "./upstream.js";
import {
  shouldAllow,
  getToolFilter,
  getResourceFilter,
  getPromptFilter,
} from "../filtering/filter.js";
import { checkAllCollisions, type ItemWithSource } from "../filtering/collision.js";
import { UpstreamError } from "../utils/errors.js";

export interface ToolWithSource {
  tool: Tool;
  serverName: string;
}

export interface ResourceWithSource {
  resource: Resource;
  serverName: string;
}

export interface PromptWithSource {
  prompt: Prompt;
  serverName: string;
}

export class Aggregator {
  private upstreamManager: UpstreamManager;

  private toolsMap: Map<string, ToolWithSource> = new Map();
  private resourcesMap: Map<string, ResourceWithSource> = new Map();
  private promptsMap: Map<string, PromptWithSource> = new Map();

  constructor(upstreamManager: UpstreamManager) {
    this.upstreamManager = upstreamManager;
  }

  refresh(): void {
    this.toolsMap.clear();
    this.resourcesMap.clear();
    this.promptsMap.clear();

    const allTools: ItemWithSource[] = [];
    const allResources: ItemWithSource[] = [];
    const allPrompts: ItemWithSource[] = [];

    for (const server of this.upstreamManager.getDiscoveredOrConnected()) {
      const tools =
        server.cachedTools.length > 0 ? server.cachedTools : server.tools;
      const resources =
        server.cachedResources.length > 0 ? server.cachedResources : server.resources;
      const prompts =
        server.cachedPrompts.length > 0 ? server.cachedPrompts : server.prompts;

      const toolFilter = getToolFilter(server.config);
      for (const tool of tools) {
        if (shouldAllow(tool.name, toolFilter)) {
          allTools.push({ name: tool.name, serverName: server.name });
          this.toolsMap.set(tool.name, { tool, serverName: server.name });
        }
      }

      const resourceFilter = getResourceFilter(server.config);
      for (const resource of resources) {
        if (shouldAllow(resource.uri, resourceFilter)) {
          allResources.push({ name: resource.uri, serverName: server.name });
          this.resourcesMap.set(resource.uri, { resource, serverName: server.name });
        }
      }

      const promptFilter = getPromptFilter(server.config);
      for (const prompt of prompts) {
        if (shouldAllow(prompt.name, promptFilter)) {
          allPrompts.push({ name: prompt.name, serverName: server.name });
          this.promptsMap.set(prompt.name, { prompt, serverName: server.name });
        }
      }
    }

    checkAllCollisions({
      tools: allTools,
      resources: allResources,
      prompts: allPrompts,
    });
  }

  getTools(): Tool[] {
    return Array.from(this.toolsMap.values()).map((t) => t.tool);
  }

  getResources(): Resource[] {
    return Array.from(this.resourcesMap.values()).map((r) => r.resource);
  }

  getPrompts(): Prompt[] {
    return Array.from(this.promptsMap.values()).map((p) => p.prompt);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const entry = this.toolsMap.get(name);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

    try {
      const client = await this.upstreamManager.ensureConnected(entry.serverName);
      const result = await client.callTool({ name, arguments: args });
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Tool call failed: ${message}` }],
        isError: true,
      };
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const entry = this.resourcesMap.get(uri);
    if (!entry) {
      throw new UpstreamError("unknown", `Resource not found: ${uri}`);
    }

    try {
      const client = await this.upstreamManager.ensureConnected(entry.serverName);
      return client.readResource({ uri });
    } catch (err) {
      throw new UpstreamError(
        entry.serverName,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const entry = this.promptsMap.get(name);
    if (!entry) {
      throw new UpstreamError("unknown", `Prompt not found: ${name}`);
    }

    try {
      const client = await this.upstreamManager.ensureConnected(entry.serverName);
      return client.getPrompt({ name, arguments: args });
    } catch (err) {
      throw new UpstreamError(
        entry.serverName,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  getStats(): { tools: number; resources: number; prompts: number } {
    return {
      tools: this.toolsMap.size,
      resources: this.resourcesMap.size,
      prompts: this.promptsMap.size,
    };
  }

  initializeFromCache(cache: {
    tools: Map<string, ToolWithSource>;
    resources: Map<string, ResourceWithSource>;
    prompts: Map<string, PromptWithSource>;
  }): void {
    this.toolsMap = new Map(cache.tools);
    this.resourcesMap = new Map(cache.resources);
    this.promptsMap = new Map(cache.prompts);
  }

  getToolsMap(): Map<string, ToolWithSource> {
    return this.toolsMap;
  }

  getResourcesMap(): Map<string, ResourceWithSource> {
    return this.resourcesMap;
  }

  getPromptsMap(): Map<string, PromptWithSource> {
    return this.promptsMap;
  }
}
