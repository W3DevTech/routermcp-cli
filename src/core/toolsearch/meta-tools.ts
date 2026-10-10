import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolSearchConfig } from "../../config/types.js";
import type { Aggregator, ToolWithSource } from "../aggregator.js";
import { type RankedTool, rankTools, type ToolRankingInput } from "./ranking.js";

const DEFAULT_SEARCH_DESCRIPTION =
  "Search and rank available MCP tools by relevance to a task description. " +
  "Provide a natural language description of what you want to accomplish, " +
  "and this tool returns the most relevant tools sorted by relevance score. " +
  "Use this to discover which tools are best suited for your task.";

const CALL_TOOL_DESCRIPTION =
  "Call an MCP tool by name with the specified arguments. " +
  "Use routermcp.searchMcpForTask first to discover available tools, " +
  "then use this tool to execute the desired tool.";

export const META_TOOL_SEARCH_MCP_FOR_TASK: Tool = {
  name: "routermcp.searchMcpForTask",
  description: DEFAULT_SEARCH_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Natural language description of the task you want to accomplish",
      },
    },
    required: ["task"],
  },
};

export const META_TOOL_CALL_TOOL: Tool = {
  name: "routermcp.callTool",
  description: CALL_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the tool to call",
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool",
      },
    },
    required: ["name"],
  },
};

/**
 * Returns both meta-tools for tool search mode.
 * Applies custom description if configured.
 */
export function getToolSearchMetaTools(config?: McpToolSearchConfig): Tool[] {
  const searchTool = config?.description
    ? { ...META_TOOL_SEARCH_MCP_FOR_TASK, description: config.description }
    : META_TOOL_SEARCH_MCP_FOR_TASK;

  return [searchTool, META_TOOL_CALL_TOOL];
}

/**
 * Handler for routermcp.searchMcpForTask.
 * Ranks tools based on task description and returns top candidates.
 */
export async function handleSearchMcpForTask(
  args: Record<string, unknown>,
  toolsMap: Map<string, ToolWithSource>,
  config: McpToolSearchConfig,
): Promise<CallToolResult> {
  const task = typeof args.task === "string" ? args.task.trim() : "";

  if (!task) {
    return {
      content: [{ type: "text", text: "Error: task parameter is required and cannot be empty" }],
      isError: true,
    };
  }

  const tools: ToolRankingInput[] = Array.from(toolsMap, ([name, { tool }]) => ({
    name,
    searchName: tool.name,
    description: tool.description || "",
  }));

  if (tools.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              topTool: null,
              candidates: [],
              query: task,
              totalTools: 0,
              message: "No tools available to search",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const ranked = rankTools(task, tools, {
    maxResults: config.maxResults ?? 5,
    minScore: config.minScore ?? 0,
    enableFuzzy: true,
  });

  const topTool = ranked.length > 0 ? ranked[0].name : null;
  const candidates = ranked.map(({ name, score }) => {
    const source = toolsMap.get(name);
    if (!source) {
      throw new Error(`Search result references unknown callable tool: ${name}`);
    }
    return {
      name,
      originalName: source.tool.name,
      serverName: source.serverName,
      score: Math.round(score * 100) / 100, // Round to 2 decimal places
    };
  });

  const response = {
    topTool,
    candidates,
    query: task,
    totalTools: tools.length,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
  };
}

/**
 * Handler for routermcp.callTool.
 * Executes a tool by name using the aggregator.
 */
export async function handleCallTool(
  args: Record<string, unknown>,
  aggregator: Aggregator,
  toolsMap: Map<string, ToolWithSource>,
): Promise<CallToolResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const toolArgs =
    typeof args.arguments === "object" && args.arguments !== null ? args.arguments : {};

  if (!name) {
    return {
      content: [{ type: "text", text: "Error: name parameter is required and cannot be empty" }],
      isError: true,
    };
  }

  // Check if tool exists
  if (!toolsMap.has(name)) {
    const availableTools = Array.from(toolsMap.keys()).slice(0, 10).join(", ");
    const message =
      `Tool not found: ${name}. ` +
      `Available tools: ${availableTools}${toolsMap.size > 10 ? ", ..." : ""}. ` +
      `Use routermcp.searchMcpForTask to discover tools.`;

    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  // Call tool through aggregator
  return aggregator.callTool(name, toolArgs as Record<string, unknown>);
}
