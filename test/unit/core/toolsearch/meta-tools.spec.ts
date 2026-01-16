import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { McpToolSearchConfig } from "../../../../src/config/types.js";
import type { Aggregator, ToolWithSource } from "../../../../src/core/aggregator.js";
import {
  META_TOOL_CALL_TOOL,
  META_TOOL_SEARCH_MCP_FOR_TASK,
  getToolSearchMetaTools,
  handleCallTool,
  handleSearchMcpForTask,
} from "../../../../src/core/toolsearch/meta-tools.js";

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
    expect(META_TOOL_SEARCH_MCP_FOR_TASK.inputSchema.required).toContain("task");
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
      tool: { name: "translate", description: "Translate text between languages" } as Tool,
      serverName: "server1",
    });
    map.set("search", {
      tool: { name: "search", description: "Search the web" } as Tool,
      serverName: "server1",
    });
    map.set("weather", {
      tool: { name: "weather", description: "Get weather information" } as Tool,
      serverName: "server2",
    });
    return map;
  };

  const defaultConfig: McpToolSearchConfig = {
    enabled: true,
    maxResults: 5,
    minScore: 0,
  };

  it("should return error for missing task parameter", async () => {
    const result = await handleSearchMcpForTask({}, createToolsMap(), defaultConfig);
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toContain("Error");
  });

  it("should return error for empty task parameter", async () => {
    const result = await handleSearchMcpForTask({ task: "   " }, createToolsMap(), defaultConfig);
    expect(result.isError).toBe(true);
  });

  it("should return ranked results for valid task", async () => {
    const result = await handleSearchMcpForTask(
      { task: "translate text" },
      createToolsMap(),
      defaultConfig,
    );
    expect(result.isError).toBeUndefined();
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response).toHaveProperty("topTool");
    expect(response).toHaveProperty("candidates");
    expect(response).toHaveProperty("query");
    expect(response).toHaveProperty("totalTools");
  });

  it("should respect maxResults configuration", async () => {
    const config: McpToolSearchConfig = {
      enabled: true,
      maxResults: 2,
      minScore: 0,
    };
    const result = await handleSearchMcpForTask({ task: "search" }, createToolsMap(), config);
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.candidates.length).toBeLessThanOrEqual(2);
  });

  it("should respect minScore configuration", async () => {
    const config: McpToolSearchConfig = {
      enabled: true,
      maxResults: 10,
      minScore: 2.0,
    };
    const result = await handleSearchMcpForTask(
      { task: "xyz irrelevant" },
      createToolsMap(),
      config,
    );
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.candidates.every((c: { score: number }) => c.score >= 2.0)).toBe(true);
  });

  it("should handle empty tools map", async () => {
    const result = await handleSearchMcpForTask({ task: "test" }, new Map(), defaultConfig);
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.topTool).toBeNull();
    expect(response.candidates).toEqual([]);
    expect(response.message).toContain("No tools available");
  });

  it("should include query in response", async () => {
    const result = await handleSearchMcpForTask(
      { task: "test query" },
      createToolsMap(),
      defaultConfig,
    );
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.query).toBe("test query");
  });

  it("should include totalTools count", async () => {
    const result = await handleSearchMcpForTask({ task: "test" }, createToolsMap(), defaultConfig);
    const response = JSON.parse((result.content[0] as { text: string }).text);
    expect(response.totalTools).toBe(3);
  });

  it("should round scores to 2 decimal places", async () => {
    const result = await handleSearchMcpForTask(
      { task: "translate" },
      createToolsMap(),
      defaultConfig,
    );
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
