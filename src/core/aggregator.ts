import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { disambiguateNames, type ItemWithSource } from "../filtering/collision.js";
import {
  getPromptFilter,
  getResourceFilter,
  getToolFilter,
  shouldAllow,
} from "../filtering/filter.js";
import { UpstreamError } from "../utils/errors.js";
import type { UpstreamManager } from "./upstream.js";

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

    const toolList: { tool: Tool; serverName: string }[] = [];
    const allTools: ItemWithSource[] = [];
    const resourceList: { resource: Resource; serverName: string }[] = [];
    const allResources: ItemWithSource[] = [];
    const promptList: { prompt: Prompt; serverName: string }[] = [];
    const allPrompts: ItemWithSource[] = [];

    for (const server of this.upstreamManager.getDiscoveredOrConnected()) {
      const tools = server.cachedTools.length > 0 ? server.cachedTools : server.tools;
      const resources =
        server.cachedResources.length > 0 ? server.cachedResources : server.resources;
      const prompts = server.cachedPrompts.length > 0 ? server.cachedPrompts : server.prompts;

      const toolFilter = getToolFilter(server.config);
      for (const tool of tools) {
        if (shouldAllow(tool.name, toolFilter)) {
          toolList.push({ tool, serverName: server.name });
          allTools.push({ name: tool.name, serverName: server.name });
        }
      }

      const resourceFilter = getResourceFilter(server.config);
      for (const resource of resources) {
        if (shouldAllow(resource.uri, resourceFilter)) {
          resourceList.push({ resource, serverName: server.name });
          allResources.push({ name: resource.uri, serverName: server.name });
        }
      }

      const promptFilter = getPromptFilter(server.config);
      for (const prompt of prompts) {
        if (shouldAllow(prompt.name, promptFilter)) {
          promptList.push({ prompt, serverName: server.name });
          allPrompts.push({ name: prompt.name, serverName: server.name });
        }
      }
    }

    const toolDisplayNames = disambiguateNames(allTools);
    for (let i = 0; i < toolList.length; i++) {
      this.toolsMap.set(toolDisplayNames[i], {
        tool: toolList[i].tool,
        serverName: toolList[i].serverName,
      });
    }
    const resourceDisplayNames = disambiguateNames(allResources);
    for (let i = 0; i < resourceList.length; i++) {
      this.resourcesMap.set(resourceDisplayNames[i], {
        resource: resourceList[i].resource,
        serverName: resourceList[i].serverName,
      });
    }
    const promptDisplayNames = disambiguateNames(allPrompts);
    for (let i = 0; i < promptList.length; i++) {
      this.promptsMap.set(promptDisplayNames[i], {
        prompt: promptList[i].prompt,
        serverName: promptList[i].serverName,
      });
    }
  }

  getTools(): Tool[] {
    return Array.from(this.toolsMap.entries()).map(([name, { tool }]) => ({ ...tool, name }));
  }

  getResources(): Resource[] {
    return Array.from(this.resourcesMap.entries()).map(([uri, { resource }]) => ({
      ...resource,
      uri,
    }));
  }

  getPrompts(): Prompt[] {
    return Array.from(this.promptsMap.entries()).map(([name, { prompt }]) => ({ ...prompt, name }));
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
      const result = await client.callTool({ name: entry.tool.name, arguments: args });
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
      return client.readResource({ uri: entry.resource.uri });
    } catch (err) {
      throw new UpstreamError(entry.serverName, err instanceof Error ? err.message : String(err));
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const entry = this.promptsMap.get(name);
    if (!entry) {
      throw new UpstreamError("unknown", `Prompt not found: ${name}`);
    }

    try {
      const client = await this.upstreamManager.ensureConnected(entry.serverName);
      return client.getPrompt({ name: entry.prompt.name, arguments: args });
    } catch (err) {
      throw new UpstreamError(entry.serverName, err instanceof Error ? err.message : String(err));
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
