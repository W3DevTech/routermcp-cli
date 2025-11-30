/**
 * Capability aggregation for tools, resources, and prompts
 */

import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "./upstream.js";
import {
  filterItems,
  getToolFilterConfig,
  getResourceFilterConfig,
  getPromptFilterConfig,
  checkCollisions,
} from "../filtering/index.js";

/**
 * Aggregated tool with source server information
 */
export interface AggregatedTool {
  tool: Tool;
  source: string;
}

/**
 * Aggregated resource with source server information
 */
export interface AggregatedResource {
  resource: Resource;
  source: string;
}

/**
 * Aggregated prompt with source server information
 */
export interface AggregatedPrompt {
  prompt: Prompt;
  source: string;
}

/**
 * Aggregates tools from all upstream servers with filtering
 *
 * @param upstreams Connected upstream servers
 * @returns Map of tool name to aggregated tool
 */
export async function aggregateTools(
  upstreams: UpstreamServer[],
): Promise<Map<string, AggregatedTool>> {
  const toolsBySource = new Map<string, string[]>();
  const allTools = new Map<string, AggregatedTool>();

  for (const upstream of upstreams) {
    const { name, client, config } = upstream;

    try {
      const caps = client.getServerCapabilities();
      if (!caps?.tools) {
        continue;
      }

      const result = await client.listTools();
      const filterConfig = getToolFilterConfig(config);
      const filteredTools = filterItems(result.tools, filterConfig);

      toolsBySource.set(
        name,
        filteredTools.map((t) => t.name),
      );

      for (const tool of filteredTools) {
        allTools.set(tool.name, { tool, source: name });
      }
    } catch {
      // Graceful degradation: skip servers that fail to list tools.
      // This allows the gateway to continue operating with other healthy upstreams.
      // Common errors include network timeouts, server crashes, or capability mismatches.
    }
  }

  // Check for collisions
  checkCollisions(toolsBySource, "tool");

  return allTools;
}

/**
 * Aggregates resources from all upstream servers with filtering
 *
 * @param upstreams Connected upstream servers
 * @returns Map of resource URI to aggregated resource
 */
export async function aggregateResources(
  upstreams: UpstreamServer[],
): Promise<Map<string, AggregatedResource>> {
  const resourcesBySource = new Map<string, string[]>();
  const allResources = new Map<string, AggregatedResource>();

  for (const upstream of upstreams) {
    const { name, client, config } = upstream;

    try {
      const caps = client.getServerCapabilities();
      if (!caps?.resources) {
        continue;
      }

      const result = await client.listResources();
      const filterConfig = getResourceFilterConfig(config);

      // Filter resources by name (URI)
      const resourcesWithName = result.resources.map((r) => ({
        ...r,
        name: r.uri, // Use URI as name for filtering
      }));
      const filteredResources = filterItems(resourcesWithName, filterConfig);

      resourcesBySource.set(
        name,
        filteredResources.map((r) => r.uri),
      );

      for (const resource of filteredResources) {
        allResources.set(resource.uri, { resource, source: name });
      }
    } catch {
      // Graceful degradation: skip servers that fail to list resources.
      // This allows the gateway to continue operating with other healthy upstreams.
      // Common errors include network timeouts, server crashes, or capability mismatches.
    }
  }

  // Check for collisions (by URI)
  checkCollisions(resourcesBySource, "resource");

  return allResources;
}

/**
 * Aggregates prompts from all upstream servers with filtering
 *
 * @param upstreams Connected upstream servers
 * @returns Map of prompt name to aggregated prompt
 */
export async function aggregatePrompts(
  upstreams: UpstreamServer[],
): Promise<Map<string, AggregatedPrompt>> {
  const promptsBySource = new Map<string, string[]>();
  const allPrompts = new Map<string, AggregatedPrompt>();

  for (const upstream of upstreams) {
    const { name, client, config } = upstream;

    try {
      const caps = client.getServerCapabilities();
      if (!caps?.prompts) {
        continue;
      }

      const result = await client.listPrompts();
      const filterConfig = getPromptFilterConfig(config);
      const filteredPrompts = filterItems(result.prompts, filterConfig);

      promptsBySource.set(
        name,
        filteredPrompts.map((p) => p.name),
      );

      for (const prompt of filteredPrompts) {
        allPrompts.set(prompt.name, { prompt, source: name });
      }
    } catch {
      // Graceful degradation: skip servers that fail to list prompts.
      // This allows the gateway to continue operating with other healthy upstreams.
      // Common errors include network timeouts, server crashes, or capability mismatches.
    }
  }

  // Check for collisions
  checkCollisions(promptsBySource, "prompt");

  return allPrompts;
}

/**
 * Result of capability aggregation
 */
export interface AggregatedCapabilities {
  tools: Map<string, AggregatedTool>;
  resources: Map<string, AggregatedResource>;
  prompts: Map<string, AggregatedPrompt>;
}

/**
 * Aggregates all capabilities from upstream servers
 *
 * @param upstreams Connected upstream servers
 * @returns Aggregated capabilities
 */
export async function aggregateCapabilities(
  upstreams: UpstreamServer[],
): Promise<AggregatedCapabilities> {
  const [tools, resources, prompts] = await Promise.all([
    aggregateTools(upstreams),
    aggregateResources(upstreams),
    aggregatePrompts(upstreams),
  ]);

  return { tools, resources, prompts };
}
