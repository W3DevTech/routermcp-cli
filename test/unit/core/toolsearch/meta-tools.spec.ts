import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { McpToolSearchConfig } from "../../../../src/config/types.js";
import { Aggregator, type ToolWithSource } from "../../../../src/core/aggregator.js";
import {
  getToolSearchMetaTools,
  handleCallTool,
  handleSearchMcpForTask,
  META_TOOL_CALL_TOOL,
  META_TOOL_SEARCH_MCP_FOR_TASK,
} from "../../../../src/core/toolsearch/meta-tools.js";
import type { UpstreamManager, UpstreamServer } from "../../../../src/core/upstream.js";
import { createTestExecutionService } from "../../../helpers/execution-service.js";

describe("META_TOOL_SEARCH_MCP_FOR_TASK", () => {
  it("should have correct name", () => {
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.name).toBe("routermcp.searchMcpForTask");
  });

  it("should have description", () => {
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.description).toBeTruthy();
    expect(typeof META_TOOL_SEARCH_MCP_FOR_TASK.description).toBe("string");
  });

  it("should have valid input schema", () => {
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.type).toBe("object");
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.properties).toHaveProperty("task");
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.properties).toHaveProperty("query");
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.properties).toHaveProperty("cursor");
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.properties).toHaveProperty("limit");
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.properties).toHaveProperty("includeSchema");
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.oneOf).toEqual([
      { required: ["task"] },
      { required: ["query"] },
    ]);
  });
});

describe("META_TOOL_CALL_TOOL", () => {
  it("should have correct name", () => {
    expect(META_TOOL_CALL_TOOL.name).toBe("routermcp.callTool");
  });

  it("should have description", () => {
    expect(META_TOOL_CALL_TOOL.description).toBeTruthy();
    expect(typeof META_TOOL_CALL_TOOL.description).toBe("string");
  });

  it("should have valid input schema", () => {
    expect(META_TOOL_CALL_TOOL.inputSchema.type).toBe("object");
    expect(META_TOOL_CALL_TOOL.inputSchema.properties).toHaveProperty("name");
    expect(META_TOOL_CALL_TOOL.inputSchema.properties).toHaveProperty("arguments");
    expect(META_TOOL_CALL_TOOL.inputSchema.required).toContain("name");
  });
});

describe("getToolSearchMetaTools", () => {
  it("should return both meta-tools", () => {
    const tools = getToolSearchMetaTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("routermcp.searchMcpForTask");
    expect(tools[1].name).toBe("routermcp.callTool");
  });

  it("should use custom description when provided", () => {
    const config: McpToolSearchConfig = {
      enabled: true,
      description: "Custom search description",
    };
    const tools = getToolSearchMetaTools(config);
    expect(tools[0].description).toBe("Custom search description");
  });

  it("should use default description when not provided", () => {
    const tools = getToolSearchMetaTools();
    expect(tools[0].description).toBeTruthy();
    expect(tools[0].description).not.toBe("Custom search description");
  });
});

describe("handleSearchMcpForTask", () => {
  const createToolsMap = (): Map<string, ToolWithSource> => {
    const map = new Map<string, ToolWithSource>();
    map.set("translate", {
      tool: {
        name: "translate",
        description: "Translate text between languages",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      } as Tool,
      serverName: "server1",
    });
    map.set("search", {
      tool: {
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      } as Tool,
      serverName: "server1",
    });
    map.set("weather", {
      tool: {
        name: "weather",
        description: "Get weather information",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      } as Tool,
      serverName: "server2",
    });
    return map;
  };

  const createRankingToolsMap = (): Map<string, ToolWithSource> =>
    new Map([
      [
        "alpha_search_files",
        {
          tool: { name: "search_files", description: "Search files" } as Tool,
          serverName: "alpha",
        },
      ],
      [
        "beta_search_documents",
        {
          tool: { name: "search_documents", description: "Search documents" } as Tool,
          serverName: "beta",
        },
      ],
      [
        "gamma_find_records",
        {
          tool: { name: "find_records", description: "Search records" } as Tool,
          serverName: "gamma",
        },
      ],
    ]);

  const defaultConfig: McpToolSearchConfig = {
    enabled: true,
    maxResults: 5,
    minScore: 0,
  };
  const createService = (
    tools: Map<string, ToolWithSource> = createToolsMap(),
    config = defaultConfig,
  ) => createTestExecutionService({ tools, toolSearch: config });

  it("should return error for missing task parameter", async () => {
    const result = await handleSearchMcpForTask({}, createService());
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toContain("Error");
  });

  it("should return error for empty task parameter", async () => {
    const result = await handleSearchMcpForTask({ task: "   " }, createService());
    expect(result.isError).toBe(true);
  });

  it("requires task and query to be used as separate search modes", async () => {
    const result = await handleSearchMcpForTask(
      { task: "translate text", query: "server:server1" },
      createService(),
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "task and query cannot be used together",
    );
  });

  it("requires paging options to use explicit query mode", async () => {
    const result = await handleSearchMcpForTask(
      { task: "translate text", limit: 10 },
      createService(),
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "cursor, limit, and includeSchema require query mode",
    );
  });

  it.each([
    { name: "non-string query", args: { query: 42 }, diagnostic: "query must be a string" },
    {
      name: "zero limit",
      args: { query: "type:tool", limit: 0 },
      diagnostic: "limit must be an integer between 1 and 50",
    },
    {
      name: "limit above maximum",
      args: { query: "type:tool", limit: 51 },
      diagnostic: "limit must be an integer between 1 and 50",
    },
    {
      name: "fractional limit",
      args: { query: "type:tool", limit: 1.5 },
      diagnostic: "limit must be an integer between 1 and 50",
    },
    {
      name: "string limit",
      args: { query: "type:tool", limit: "1" },
      diagnostic: "limit must be an integer between 1 and 50",
    },
    {
      name: "non-string cursor",
      args: { query: "type:tool", cursor: 1 },
      diagnostic: "cursor must be a valid encoded search cursor",
    },
    {
      name: "empty cursor",
      args: { query: "type:tool", cursor: "" },
      diagnostic: "cursor must be a valid encoded search cursor",
    },
    {
      name: "oversized cursor",
      args: { query: "type:tool", cursor: "x".repeat(16_385) },
      diagnostic: "cursor must be a valid encoded search cursor",
    },
    {
      name: "non-boolean includeSchema",
      args: { query: "type:tool", includeSchema: "true" },
      diagnostic: "includeSchema must be a boolean",
    },
    {
      name: "unclosed query quote",
      args: { query: '"unfinished' },
      diagnostic: "UNCLOSED_QUOTE:",
    },
    {
      name: "hosted-only team qualifier",
      args: { query: "team:core" },
      diagnostic: "UNSUPPORTED_QUALIFIER:",
    },
  ])("returns a stable MCP error for $name", async ({ args, diagnostic }) => {
    const result = await handleSearchMcpForTask(args, createService());

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text" }],
    });
    const message = (result.content[0] as { text: string }).text;
    expect(message).toContain("Error:");
    expect(message).toContain(diagnostic);
    expect(message).not.toMatch(/"results"|"inputSchema"/u);
  });

  it("should return ranked results for valid task", async () => {
    const result = await handleSearchMcpForTask({ task: "translate text" }, createService());
    expect(result.isError).toBeUndefined();
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response).toHaveProperty("topTool");
    expect(response).toHaveProperty("candidates");
    expect(response).toHaveProperty("query");
    expect(response).toHaveProperty("totalTools");
  });

  it("returns the callable identity and routes a colliding beta result to beta", async () => {
    const { aggregator, clients, toolsMap } = createCollidingTools();
    const betaCallableName = [...toolsMap].find(([, entry]) => entry.serverName === "beta")?.[0];
    expect(betaCallableName).toBeDefined();

    const result = await handleSearchMcpForTask(
      { task: "resolve Acme billing invoice" },
      createService(toolsMap),
    );
    const response = JSON.parse((result.content[0] as { text: string }).text);

    await handleCallTool(
      { name: response.topTool, arguments: { invoice: "INV-7" } },
      aggregator,
      toolsMap,
    );

    expect(clients.alpha.callTool).not.toHaveBeenCalled();
    expect(clients.beta.callTool).toHaveBeenCalledWith({
      name: "lookup",
      arguments: { invoice: "INV-7" },
    });
    expect(response.topTool).toBe(betaCallableName);
    expect(response.candidates[0]).toMatchObject({
      name: betaCallableName,
      originalName: "lookup",
      serverName: "beta",
    });
  });

  it("returns no candidates when every tool has zero relevance at the default threshold", async () => {
    const result = await handleSearchMcpForTask({ task: "zzzxqv" }, createService());
    const response = JSON.parse((result.content[0] as { text: string }).text);

    expect(response.topTool).toBeNull();
    expect(response.candidates).toEqual([]);
  });

  it("should respect maxResults configuration", async () => {
    const config: McpToolSearchConfig = {
      enabled: true,
      maxResults: 2,
      minScore: 0,
    };
    const result = await handleSearchMcpForTask(
      { task: "search" },
      createService(createRankingToolsMap(), config),
    );
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.candidates.map((candidate: { name: string }) => candidate.name)).toEqual([
      "alpha_search_files",
      "beta_search_documents",
    ]);
  });

  it("should respect minScore configuration", async () => {
    const config: McpToolSearchConfig = {
      enabled: true,
      maxResults: 10,
      minScore: 2.25,
    };
    const result = await handleSearchMcpForTask(
      { task: "search" },
      createService(createRankingToolsMap(), config),
    );
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.candidates.map((candidate: { name: string }) => candidate.name)).toEqual([
      "alpha_search_files",
      "beta_search_documents",
    ]);
  });

  it("should handle empty tools map", async () => {
    const result = await handleSearchMcpForTask({ task: "test" }, createService(new Map()));
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.topTool).toBeNull();
    expect(response.candidates).toEqual([]);
    expect(response.message).toContain("No tools available");
  });

  it("should include query in response", async () => {
    const result = await handleSearchMcpForTask({ task: "test query" }, createService());
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.query).toBe("test query");
  });

  it("should include totalTools count", async () => {
    const result = await handleSearchMcpForTask({ task: "test" }, createService());
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.totalTools).toBe(3);
  });

  it("preserves fuzzy legacy task matching by default and supports disabling it", async () => {
    const legacy = await handleSearchMcpForTask({ task: "trnslate" }, createService());
    const disabled = await handleSearchMcpForTask(
      { task: "trnslate" },
      createService(createToolsMap(), { ...defaultConfig, enableFuzzy: false }),
    );
    const legacyResponse = JSON.parse((legacy.content[0] as { text: string }).text);
    const disabledResponse = JSON.parse((disabled.content[0] as { text: string }).text);

    expect(legacyResponse.topTool).toBe("translate");
    expect(disabledResponse.candidates).toEqual([]);
  });

  it("returns exact callable identities in literal query results and opts into schemas", async () => {
    const { aggregator, clients, toolsMap } = createCollidingTools();
    const service = createService(toolsMap);
    const withoutSchema = await handleSearchMcpForTask({ query: "invoice" }, service);
    const firstPage = JSON.parse((withoutSchema.content[0] as { text: string }).text);
    const betaCallableName = [...toolsMap].find(([, entry]) => entry.serverName === "beta")?.[0];

    expect(withoutSchema.isError).toBeUndefined();
    expect(firstPage.results).toHaveLength(1);
    expect(firstPage.results[0]).toMatchObject({
      name: betaCallableName,
      originalName: "lookup",
      serverName: "beta",
    });
    expect(firstPage.results[0]).not.toHaveProperty("inputSchema");

    await handleCallTool(
      { name: firstPage.results[0].name, arguments: { invoice: "INV-7" } },
      aggregator,
      toolsMap,
    );
    expect(clients.alpha.callTool).not.toHaveBeenCalled();
    expect(clients.beta.callTool).toHaveBeenCalledWith({
      name: "lookup",
      arguments: { invoice: "INV-7" },
    });

    const withSchema = await handleSearchMcpForTask(
      { query: "invoice", includeSchema: true },
      service,
    );
    const schemaPage = JSON.parse((withSchema.content[0] as { text: string }).text);
    expect(schemaPage.results[0]?.inputSchema).toMatchObject({
      properties: { invoice: { type: "string" } },
    });
  });

  it("should round scores to 2 decimal places", async () => {
    const result = await handleSearchMcpForTask({ task: "translate" }, createService());
    const response = JSON.parse((result.content[0] as { text: string }).text);
    response.candidates.forEach((c: { score: number }) => {
      const scoreStr = c.score.toString();
      const decimalPart = scoreStr.split(".")[1];
      if (decimalPart) {
        expect(decimalPart.length).toBeLessThanOrEqual(2);
      }
    });
  });
});

function createCollidingTools(): {
  aggregator: Aggregator;
  clients: {
    alpha: { callTool: ReturnType<typeof vi.fn> };
    beta: { callTool: ReturnType<typeof vi.fn> };
  };
  toolsMap: Map<string, ToolWithSource>;
} {
  const alphaTool = {
    name: "lookup",
    description: "Find an internal support request by its short id",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  } as Tool;
  const betaTool = {
    name: "lookup",
    description: "Resolve Acme billing invoices and payment status",
    inputSchema: { type: "object", properties: { invoice: { type: "string" } } },
  } as Tool;
  const servers: UpstreamServer[] = [
    createServer("alpha", alphaTool),
    createServer("beta", betaTool),
  ];
  const clients = {
    alpha: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "alpha result" }] }),
    },
    beta: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "beta result" }] }),
    },
  };
  const manager = {
    getDiscoveredOrConnected: () => servers,
    ensureConnected: vi.fn(async (serverName: string) => clients[serverName as "alpha" | "beta"]),
  } as unknown as UpstreamManager;
  const aggregator = new Aggregator(manager);
  aggregator.refresh();

  return { aggregator, clients, toolsMap: aggregator.getToolsMap() };
}

function createServer(name: string, tool: Tool): UpstreamServer {
  return {
    name,
    config: { transport: "stdio", command: "fake" },
    status: "discovered",
    client: null,
    cleanup: null,
    error: null,
    tools: [tool],
    resources: [],
    prompts: [],
    cachedTools: [tool],
    cachedResources: [],
    cachedPrompts: [],
    lastActivity: null,
    idleTimer: null,
    connectionPromise: null,
  };
}

describe("handleCallTool", () => {
  const createMockAggregator = (): Aggregator => {
    return {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "translate") {
          return {
            content: [{ type: "text", text: "Translated text" }],
          };
        }
        return {
          content: [{ type: "text", text: "Tool result" }],
        };
      }),
    } as unknown as Aggregator;
  };

  const createToolsMap = (): Map<string, ToolWithSource> => {
    const map = new Map<string, ToolWithSource>();
    map.set("translate", {
      tool: { name: "translate", description: "Translate text" } as Tool,
      serverName: "server1",
    });
    return map;
  };

  it("should return error for missing name parameter", async () => {
    const result = await handleCallTool({}, createMockAggregator(), createToolsMap());
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Error");
  });

  it("should return error for empty name parameter", async () => {
    const result = await handleCallTool({ name: "   " }, createMockAggregator(), createToolsMap());
    expect(result.isError).toBe(true);
  });

  it("should return error for non-existent tool", async () => {
    const result = await handleCallTool(
      { name: "nonexistent" },
      createMockAggregator(),
      createToolsMap(),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Tool not found");
  });

  it("should call tool through aggregator", async () => {
    const aggregator = createMockAggregator();
    const result = await handleCallTool(
      { name: "translate", arguments: { text: "hello" } },
      aggregator,
      createToolsMap(),
    );
    expect(aggregator.callTool).toHaveBeenCalledWith("translate", { text: "hello" });
  });

  it("should return tool result", async () => {
    const result = await handleCallTool(
      { name: "translate", arguments: { text: "hello" } },
      createMockAggregator(),
      createToolsMap(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toBe("Translated text");
  });

  it("should handle missing arguments parameter", async () => {
    const aggregator = createMockAggregator();
    const result = await handleCallTool({ name: "translate" }, aggregator, createToolsMap());
    expect(aggregator.callTool).toHaveBeenCalledWith("translate", {});
  });

  it("should suggest using searchMcpForTask in error message", async () => {
    const result = await handleCallTool(
      { name: "nonexistent" },
      createMockAggregator(),
      createToolsMap(),
    );
    expect((result.content[0] as { text: string }).text).toContain("routermcp.searchMcpForTask");
  });

  it("should list available tools in error message", async () => {
    const result = await handleCallTool(
      { name: "nonexistent" },
      createMockAggregator(),
      createToolsMap(),
    );
    expect((result.content[0] as { text: string }).text).toContain("Available tools");
  });
});
