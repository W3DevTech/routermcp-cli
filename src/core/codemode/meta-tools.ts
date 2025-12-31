import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Aggregator, ToolWithSource } from "../aggregator.js";
import type { CodeModeConfig } from "../../config/types.js";
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
  toolsMap: Map<string, ToolWithSource>,
): Promise<CallToolResult> {
  const filter = typeof args.filter === "string" ? args.filter.toLowerCase().trim() : "";

  const toolInfoList = toolsToToolInfo(toolsMap);

  let filtered = toolInfoList;
  if (filter) {
    filtered = toolInfoList.filter((t) => {
      const fullName = `${t.serverName}.${t.name}`.toLowerCase();
      const desc = (t.description ?? "").toLowerCase();
      return fullName.includes(filter) || desc.includes(filter);
    });
  }

  const typeDefinitions = generateTypeScriptDefinitions(filtered);

  return {
    content: [
      {
        type: "text",
        text: typeDefinitions,
      },
    ],
  };
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
