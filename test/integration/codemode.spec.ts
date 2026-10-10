import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { CodeModeConfig } from "../../src/config/types.js";
import { Aggregator, type ToolWithSource } from "../../src/core/aggregator.js";
import type { UpstreamManager } from "../../src/core/upstream.js";
import {
  getCodeModeMetaTools,
  handleExecuteCode,
  handleListTools,
  META_TOOL_EXECUTE_CODE,
  META_TOOL_LIST_TOOLS,
} from "../../src/core/codemode/meta-tools.js";

function createMockToolsMap(): Map<string, ToolWithSource> {
  const map = new Map<string, ToolWithSource>();

  map.set("read_file", {
    tool: {
      name: "read_file",
      description: "Read a file from disk",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
    serverName: "filesystem",
  } as ToolWithSource);

  map.set("echo", {
    tool: {
      name: "echo",
      description: "Echo a message back",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message to echo" },
        },
        required: ["message"],
      },
    },
    serverName: "everything",
  } as ToolWithSource);

  return map;
}

function createMockAggregator(toolResults: Record<string, unknown> = {}): Aggregator {
  return {
    callTool: vi.fn().mockImplementation(async (name: string, args: unknown) => {
      if (name in toolResults) {
        return toolResults[name];
      }
      return { content: [{ type: "text", text: `result from ${name}` }] };
    }),
    getTools: vi.fn().mockReturnValue(createMockToolsMap()),
    refresh: vi.fn(),
  } as unknown as Aggregator;
}

describe("Code Mode meta-tools", () => {
  describe("getCodeModeMetaTools", () => {
    it("returns both meta-tools", () => {
      const tools = getCodeModeMetaTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("routermcp.listTools");
      expect(tools[1].name).toBe("routermcp.executeCode");
    });

    it("META_TOOL_LIST_TOOLS has correct schema", () => {
      expect(META_TOOL_LIST_TOOLS.name).toBe("routermcp.listTools");
      expect(META_TOOL_LIST_TOOLS.inputSchema.properties).toHaveProperty("filter");
    });

    it("META_TOOL_EXECUTE_CODE has correct schema", () => {
      expect(META_TOOL_EXECUTE_CODE.name).toBe("routermcp.executeCode");
      expect(META_TOOL_EXECUTE_CODE.inputSchema.required).toContain("code");
    });
  });

  describe("handleListTools", () => {
    it("returns TypeScript definitions for all tools", async () => {
      const toolsMap = createMockToolsMap();

      const result = await handleListTools({}, toolsMap);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("declare const filesystem:");
      expect(text).toContain("declare const everything:");
      expect(text).toContain("read_file:");
      expect(text).toContain("echo:");
    });

    it("filters tools by name", async () => {
      const toolsMap = createMockToolsMap();

      const result = await handleListTools({ filter: "read" }, toolsMap);

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("read_file:");
      expect(text).not.toContain("echo:");
    });

    it("filters tools by description", async () => {
      const toolsMap = createMockToolsMap();

      const result = await handleListTools({ filter: "echo" }, toolsMap);

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("echo:");
    });

    it("includes built-in declarations", async () => {
      const toolsMap = new Map<string, ToolWithSource>();

      const result = await handleListTools({}, toolsMap);

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("declare function fetch");
      expect(text).toContain("declare const console:");
    });

    it("handles empty filter", async () => {
      const toolsMap = createMockToolsMap();

      const result = await handleListTools({ filter: "" }, toolsMap);

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("read_file:");
      expect(text).toContain("echo:");
    });
  });

  describe("handleExecuteCode", () => {
    const defaultConfig: CodeModeConfig = {
      enabled: true,
      timeout: 30000,
      allowFetch: true,
    };

    it("executes simple code and returns result", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode(
        { code: "return 1 + 1" },
        aggregator,
        toolsMap,
        defaultConfig,
      );

      expect(result.isError).toBeFalsy();

      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe(2);
    });

    it("returns error for empty code", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode({ code: "" }, aggregator, toolsMap, defaultConfig);

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: "text"; text: string }).text).toContain(
        "code parameter is required",
      );
    });

    it("returns error for whitespace-only code", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode({ code: "   " }, aggregator, toolsMap, defaultConfig);

      expect(result.isError).toBe(true);
    });

    it("can call tools from code", async () => {
      const aggregator = createMockAggregator({
        echo: { content: [{ type: "text", text: "Hello!" }] },
      });
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode(
        { code: 'const r = await everything.echo({ message: "Hi" }); return r' },
        aggregator,
        toolsMap,
        defaultConfig,
      );

      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.success).toBe(true);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(parsed.toolCalls[0].tool).toBe("everything.echo");
    });

    it("routes a server-qualified original name through its callable map key", async () => {
      const { aggregator, clients, toolsMap } = createCollidingTools();
      const listing = await handleListTools({}, toolsMap);
      const definitions = (listing.content[0] as { type: "text"; text: string }).text;
      expect(definitions).toContain("declare const beta:");
      expect(definitions).toContain("lookup:");

      const result = await handleExecuteCode(
        { code: 'return await beta.lookup({ invoice: "INV-7" })' },
        aggregator,
        toolsMap,
        { enabled: true, timeout: 30000, allowFetch: true },
      );
      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);

      expect(parsed.success).toBe(true);
      expect(clients.alpha.callTool).not.toHaveBeenCalled();
      expect(clients.beta.callTool).toHaveBeenCalledWith({
        name: "lookup",
        arguments: { invoice: "INV-7" },
      });
      expect(parsed.toolCalls[0].tool).toBe("beta.lookup");
    });

    it("captures console.log output", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode(
        { code: 'console.log("hello"); return true' },
        aggregator,
        toolsMap,
        defaultConfig,
      );

      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.logs).toContain("hello");
    });

    it("returns duration", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode(
        { code: "return 42" },
        aggregator,
        toolsMap,
        defaultConfig,
      );

      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.duration).toBeGreaterThanOrEqual(0);
    });

    it("handles syntax errors", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode(
        { code: "invalid syntax {{{{" },
        aggregator,
        toolsMap,
        defaultConfig,
      );

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.success).toBe(false);
      expect(parsed.errors.length).toBeGreaterThan(0);
    });

    it("handles runtime errors", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();

      const result = await handleExecuteCode(
        { code: "throw new Error('test error')" },
        aggregator,
        toolsMap,
        defaultConfig,
      );

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.success).toBe(false);
      expect(parsed.errors.some((e: string) => e.includes("test error"))).toBe(true);
    });

    it("respects timeout configuration", async () => {
      const aggregator = createMockAggregator();
      const toolsMap = createMockToolsMap();
      const config: CodeModeConfig = {
        enabled: true,
        timeout: 100,
        allowFetch: true,
      };

      const result = await handleExecuteCode(
        { code: "while(true) {}" },
        aggregator,
        toolsMap,
        config,
      );

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
      expect(parsed.success).toBe(false);
    }, 10000);
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
  const clients = {
    alpha: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "alpha result" }] }),
    },
    beta: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "beta result" }] }),
    },
  };
  const manager = {
    ensureConnected: vi.fn(async (serverName: string) => clients[serverName as "alpha" | "beta"]),
  } as unknown as UpstreamManager;
  const aggregator = new Aggregator(manager);
  const toolsMap = new Map<string, ToolWithSource>([
    [
      "lookup",
      {
        tool: {
          name: "lookup",
          description: "Find an internal support request",
          inputSchema: { type: "object", properties: {} },
        } as Tool,
        serverName: "alpha",
      },
    ],
    [
      "lookup_beta",
      {
        tool: {
          name: "lookup",
          description: "Resolve Acme billing invoices and payment status",
          inputSchema: { type: "object", properties: {} },
        } as Tool,
        serverName: "beta",
      },
    ],
  ]);
  aggregator.initializeFromCache({ tools: toolsMap, resources: new Map(), prompts: new Map() });

  return { aggregator, clients, toolsMap };
}
