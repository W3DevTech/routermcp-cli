import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolSearchConfig } from "../../config/types.js";
import type { Aggregator, ToolWithSource } from "../aggregator.js";
import type { ExecutionService, ExecutionToolQueryOptions } from "../execution-service.js";

const DEFAULT_SEARCH_DESCRIPTION =
  "Search and rank available MCP tools by relevance to a task description. " +
  "Use task for natural-language fuzzy ranking or query for literal filters and paged results. " +
  "Use this to discover available tools before calling them.";

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
        description: "Natural-language task description for legacy fuzzy ranking",
      },
      query: {
        type: "string",
        description: "Literal search query with optional type, server, or transport qualifiers",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum results in this query page (default 20)",
      },
      cursor: {
        type: "string",
        description: "Cursor returned by the previous query page",
      },
      includeSchema: {
        type: "boolean",
        description: "Include tool input schemas in explicit-query results",
      },
    },
    oneOf: [{ required: ["task"] }, { required: ["query"] }],
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
  executionService: ExecutionService,
): Promise<CallToolResult> {
  const hasTask = args.task !== undefined;
  const hasQuery = args.query !== undefined;
  if (hasTask && hasQuery) {
    return {
      content: [{ type: "text", text: "Error: task and query cannot be used together" }],
      isError: true,
    };
  }

  if (hasQuery) {
    const options: ExecutionToolQueryOptions = {
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.includeSchema !== undefined ? { includeSchema: args.includeSchema } : {}),
    };
    try {
      const result = executionService.queryTools(args.query, options);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool search failed";
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }

  if (args.cursor !== undefined || args.limit !== undefined || args.includeSchema !== undefined) {
    return {
      content: [
        { type: "text", text: "Error: cursor, limit, and includeSchema require query mode" },
      ],
      isError: true,
    };
  }

  if (typeof args.task !== "string" || args.task.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Error: task parameter is required and cannot be empty" }],
      isError: true,
    };
  }

  try {
    const result = executionService.searchTools(args.task);
    const response = {
      ...result,
      ...(result.totalTools === 0 ? { message: "No tools available to search" } : {}),
    };
    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task search failed";
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
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
