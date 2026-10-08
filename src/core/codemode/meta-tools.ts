import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CodeModeConfig } from "../../config/types.js";
import type { Aggregator, ToolWithSource } from "../aggregator.js";
import type { ExecutionService } from "../execution-service.js";
import { generateTypeScriptDefinitions, groupToolsByServer, toolsToToolInfo } from "./codegen.js";
import { executeCodeMode } from "./sandbox.js";

export const META_TOOL_LIST_TOOLS: Tool = {
  name: "routermcp.listTools",
  description:
    "Lists all available MCP tools with TypeScript type definitions. " +
    "Use this to discover what tools are available before writing code. " +
    "Returns TypeScript declarations that describe each tool's name, parameters, and types.",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional filter string to search tools by name or description",
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
  },
};

export const META_TOOL_EXECUTE_CODE: Tool = {
  name: "routermcp.executeCode",
  description:
    "Executes JavaScript code in a secure sandbox with access to all MCP tools. " +
    "First call routermcp.listTools to see available tools and their TypeScript definitions. " +
    "Then write JavaScript code that calls those tools. " +
    "The code runs in an isolated environment with console.log for debugging. " +
    "Use 'return' to return a final value from your code.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code to execute. Has access to tool namespaces (e.g., github.create_issue({...})). " +
          "Use async/await for tool calls. Use console.log() for debugging. Use 'return' for final value.",
      },
    },
    required: ["code"],
  },
};

export function getCodeModeMetaTools(): Tool[] {
  return [META_TOOL_LIST_TOOLS, META_TOOL_EXECUTE_CODE];
}

export async function handleListTools(
  args: Record<string, unknown>,
  executionService: ExecutionService,
): Promise<CallToolResult> {
  if (args.query !== undefined) {
    if (args.filter !== undefined) {
      return {
        content: [{ type: "text", text: "Error: filter and query cannot be used together" }],
        isError: true,
      };
    }
    try {
      const result = executionService.queryTools(args.query, {
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.includeSchema !== undefined ? { includeSchema: args.includeSchema } : {}),
      });
      const typeDefinitions = generateTypeScriptDefinitions(
        result.results.map((tool) => ({
          serverName: tool.serverName,
          name: tool.originalName,
          callableName: tool.name,
          transport: tool.transport,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, typeDefinitions }, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool listing failed";
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

  const filter = typeof args.filter === "string" ? args.filter : "";
  try {
    const result = executionService.listTools(filter);
    return { content: [{ type: "text", text: result.typeDefinitions }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool listing failed";
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

export async function handleExecuteCode(
  args: Record<string, unknown>,
  aggregator: Aggregator,
  toolsMap: Map<string, ToolWithSource>,
  config: CodeModeConfig,
): Promise<CallToolResult> {
  const code = typeof args.code === "string" ? args.code : "";

  if (!code.trim()) {
    return {
      content: [{ type: "text", text: "Error: code parameter is required" }],
      isError: true,
    };
  }

  const toolInfoList = toolsToToolInfo(toolsMap);
  const toolsByServer = groupToolsByServer(toolInfoList);

  const result = await executeCodeMode(code, aggregator, toolsByServer, {
    timeout: config.timeout ?? 30000,
    allowFetch: config.allowFetch ?? true,
  });

  const resultData = {
    success: result.success,
    result: result.result,
    logs: result.logs,
    errors: result.errors,
    toolCalls: result.toolCalls,
    duration: result.duration,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(resultData, null, 2),
      },
    ],
    isError: !result.success,
  };
}
