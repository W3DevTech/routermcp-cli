import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CodeModeConfig, McpToolSearchConfig } from "../config/types.js";
import {
  generateTypeScriptDefinitions,
  groupToolsByServer,
  toolsToToolInfo,
} from "./codemode/codegen.js";
import {
  type CodeModeResult,
  executeCodeMode,
  type ToolCallDispatcher,
} from "./codemode/sandbox.js";
import { rankToolCandidates, SearchError } from "./search/index.js";
import {
  searchToolCatalog,
  TOOL_SEARCH_DEFAULT_PAGE_SIZE,
  TOOL_SEARCH_MAX_CURSOR_LENGTH,
  TOOL_SEARCH_MAX_PAGE_SIZE,
  ToolSearchCursorError,
  type ToolSearchPage,
} from "./toolsearch/search-adapter.js";
import type { CachedCapabilities, VirtualSession } from "./virtual-session.js";

export type { ToolSearchPage } from "./toolsearch/search-adapter.js";

export const EXECUTION_CODE_MAX_LENGTH = 64 * 1024;
export const EXECUTION_ARGUMENTS_MAX_BYTES = 64 * 1024;
export const EXECUTION_FILTER_MAX_LENGTH = 256;
export const EXECUTION_TASK_MAX_LENGTH = 2_048;

export type ExecutionOperation = "tool-call" | "code-run";

export interface ExecutionTool {
  name: string;
  callableName: string;
  serverName: string;
  description: string | null;
  inputSchema: unknown;
}

export interface ExecutionSearchResult {
  topTool: string | null;
  candidates: Array<{
    name: string;
    originalName: string;
    serverName: string;
    score: number;
  }>;
  query: string;
  totalTools: number;
}

export interface ExecutionToolQueryOptions {
  cursor?: unknown;
  limit?: unknown;
  includeSchema?: unknown;
}

export interface ExecutionRuntime {
  getCapabilities: () => CachedCapabilities | null;
  getSession: (sessionId: string) => VirtualSession;
  callTool: (
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
  cleanupSession?: (sessionId: string) => Promise<void>;
  getCodeModeConfig: () => CodeModeConfig | undefined;
  getToolSearchConfig: () => McpToolSearchConfig | undefined;
}

export class ExecutionError extends Error {
  readonly code: "invalid-request" | "not-ready" | "feature-disabled" | "unknown-tool";
  readonly status: 400 | 404 | 409;

  constructor(message: string, code: ExecutionError["code"], status: ExecutionError["status"]) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * One execution boundary shared by MCP meta-tools and authenticated daemon
 * management routes. Keeping the implementation here prevents the hosted UI
 * from growing a second, subtly different tool/search/code path.
 */
export class ExecutionService {
  constructor(private readonly runtime: ExecutionRuntime) {}

  listTools(filter = ""): { tools: ExecutionTool[]; typeDefinitions: string } {
    const capabilities = this.requireCapabilities();
    const normalizedFilter = validateString(filter, "filter", EXECUTION_FILTER_MAX_LENGTH);
    const toolInfo = toolsToToolInfo(capabilities.tools);
    const filtered = normalizedFilter
      ? toolInfo.filter((tool) => {
          const fullName = `${tool.serverName}.${tool.name}`.toLowerCase();
          const description = (tool.description ?? "").toLowerCase();
          const query = normalizedFilter.toLowerCase();
          return fullName.includes(query) || description.includes(query);
        })
      : toolInfo;

    return {
      tools: filtered.map((tool) => ({
        name: tool.name,
        callableName: tool.callableName ?? tool.name,
        serverName: tool.serverName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      typeDefinitions: generateTypeScriptDefinitions(filtered),
    };
  }

  searchTools(task: unknown): ExecutionSearchResult {
    const capabilities = this.requireCapabilities();
    const query = validateString(task, "task", EXECUTION_TASK_MAX_LENGTH, true);
    const tools = Array.from(capabilities.tools, ([identity, { tool }]) => ({
      identity,
      name: tool.name,
      description: tool.description ?? "",
    }));
    const config = this.runtime.getToolSearchConfig() ?? {};
    const ranked = rankToolCandidates(query, tools, {
      profile: "cli",
      minScore: config.minScore ?? 0,
      enableFuzzy: config.enableFuzzy ?? true,
    }).slice(0, config.maxResults ?? 5);

    return {
      topTool: ranked[0]?.identity ?? null,
      candidates: ranked.map(({ identity, score }) => {
        const source = capabilities.tools.get(identity);
        if (!source) {
          throw new Error(`Search result references unknown callable tool: ${identity}`);
        }
        return {
          name: identity,
          originalName: source.tool.name,
          serverName: source.serverName,
          score: Math.round(score * 100) / 100,
        };
      }),
      query,
      totalTools: tools.length,
    };
  }

  queryTools(query: unknown, options: ExecutionToolQueryOptions = {}): ToolSearchPage {
    const capabilities = this.requireCapabilities();
    if (typeof query !== "string") {
      throw new ExecutionError("query must be a string", "invalid-request", 400);
    }

    const limit = validatePageLimit(options.limit);
    const cursor = validateCursor(options.cursor);
    const includeSchema = validateIncludeSchema(options.includeSchema);

    try {
      return searchToolCatalog(capabilities.tools, query, {
        ...(cursor ? { cursor } : {}),
        limit,
        includeSchema,
      });
    } catch (error) {
      if (error instanceof SearchError) {
        const span = error.span ? ` (characters ${error.span.start}-${error.span.end})` : "";
        throw new ExecutionError(`${error.code}: ${error.message}${span}`, "invalid-request", 400);
      }
      if (error instanceof ToolSearchCursorError) {
        throw new ExecutionError(error.message, "invalid-request", 400);
      }
      throw error;
    }
  }

  async callTool(sessionId: string, name: string, args: unknown): Promise<CallToolResult> {
    const capabilities = this.requireCapabilities();
    const toolName = validateString(name, "name", 512, true);
    const tool = capabilities.tools.get(toolName);
    if (!tool) {
      throw new ExecutionError("The requested tool is not available", "unknown-tool", 404);
    }
    const toolArgs = validateArguments(args);
    const result = await this.runtime.callTool(sessionId, toolName, toolArgs);
    // Upstream adapters may include transport URLs, authorization details, or
    // subprocess paths in error text. Management responses use a stable error
    // message; normal MCP callers retain the existing detailed behavior.
    return result.isError
      ? { content: [{ type: "text", text: "The tool call failed" }], isError: true }
      : result;
  }

  async executeCode(sessionId: string, code: string): Promise<CodeModeResult> {
    const capabilities = this.requireCapabilities();
    const codeMode = this.runtime.getCodeModeConfig();
    if (codeMode?.enabled !== true) {
      throw new ExecutionError("Code Mode is disabled for this workspace", "feature-disabled", 409);
    }
    const source = validateString(code, "code", EXECUTION_CODE_MAX_LENGTH, true);
    this.runtime.getSession(sessionId);
    const toolInfo = toolsToToolInfo(capabilities.tools);
    const toolsByServer = groupToolsByServer(toolInfo);
    const dispatcher: ToolCallDispatcher = {
      callTool: (name, args) => this.runtime.callTool(sessionId, name, args),
    };
    return executeCodeMode(source, dispatcher, toolsByServer, {
      timeout: codeMode.timeout ?? 30_000,
      allowFetch: codeMode.allowFetch ?? true,
    });
  }

  async cleanupSession(sessionId: string): Promise<void> {
    await this.runtime.cleanupSession?.(sessionId);
  }

  private requireCapabilities(): CachedCapabilities {
    const capabilities = this.runtime.getCapabilities();
    if (!capabilities) {
      throw new ExecutionError("Workspace runtime is not ready", "not-ready", 409);
    }
    return capabilities;
  }
}

function validateString(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): string {
  if (typeof value !== "string") {
    throw new ExecutionError(`${field} must be a string`, "invalid-request", 400);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ExecutionError(`${field} is required and cannot be empty`, "invalid-request", 400);
  }
  if (normalized.length > maxLength) {
    throw new ExecutionError(`${field} exceeds the maximum allowed length`, "invalid-request", 400);
  }
  return normalized;
}

function validateArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("arguments must be a JSON object", "invalid-request", 400);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ExecutionError("arguments must be JSON serializable", "invalid-request", 400);
  }
  if (new TextEncoder().encode(serialized).byteLength > EXECUTION_ARGUMENTS_MAX_BYTES) {
    throw new ExecutionError("arguments exceed the maximum allowed size", "invalid-request", 400);
  }
  return value as Record<string, unknown>;
}

function validatePageLimit(value: unknown): number {
  if (value === undefined) return TOOL_SEARCH_DEFAULT_PAGE_SIZE;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > TOOL_SEARCH_MAX_PAGE_SIZE
  ) {
    throw new ExecutionError(
      `limit must be an integer between 1 and ${TOOL_SEARCH_MAX_PAGE_SIZE}`,
      "invalid-request",
      400,
    );
  }
  return value;
}

function validateCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > TOOL_SEARCH_MAX_CURSOR_LENGTH
  ) {
    throw new ExecutionError(
      "cursor must be a valid encoded search cursor",
      "invalid-request",
      400,
    );
  }
  return value;
}

function validateIncludeSchema(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ExecutionError("includeSchema must be a boolean", "invalid-request", 400);
  }
  return value;
}
