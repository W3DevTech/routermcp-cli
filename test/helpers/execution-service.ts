import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CodeModeConfig, McpToolSearchConfig } from "../../src/config/types.js";
import type { ToolWithSource } from "../../src/core/aggregator.js";
import { ExecutionService } from "../../src/core/execution-service.js";
import type { CachedCapabilities, VirtualSession } from "../../src/core/virtual-session.js";

interface TestExecutionServiceOptions {
  tools: Map<string, ToolWithSource>;
  codeMode?: CodeModeConfig;
  toolSearch?: McpToolSearchConfig;
  callTool?: (
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
}

export function createTestExecutionService({
  tools,
  codeMode,
  toolSearch,
  callTool,
}: TestExecutionServiceOptions): ExecutionService {
  const capabilities: CachedCapabilities = {
    tools,
    resources: new Map(),
    prompts: new Map(),
    serverCapabilities: new Map(),
  };
  return new ExecutionService({
    getCapabilities: () => capabilities,
    getSession: () => ({}) as VirtualSession,
    callTool: callTool ?? (async () => ({ content: [] })),
    getCodeModeConfig: () => codeMode,
    getToolSearchConfig: () => toolSearch,
  });
}
