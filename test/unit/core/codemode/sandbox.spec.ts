import { describe, it, expect, vi } from "vitest";
import { executeCodeMode, type SandboxConfig } from "../../../../src/core/codemode/sandbox.js";
import type { Aggregator } from "../../../../src/core/aggregator.js";

function createMockAggregator(toolResults: Record<string, unknown> = {}): Aggregator {
  return {
    callTool: vi.fn().mockImplementation(async (name: string) => {
      if (name in toolResults) {
        return toolResults[name];
      }
      return { content: [{ type: "text", text: `result from ${name}` }] };
    }),
  } as unknown as Aggregator;
}

describe("executeCodeMode", () => {
  describe("basic execution", () => {
    it("executes simple code and returns result", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return 1 + 1", aggregator, toolsByServer);

      expect(result.success).toBe(true);
      expect(result.result).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it("captures console.log output", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'console.log("hello"); console.log("world"); return "done"',
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.logs).toContain("hello");
      expect(result.logs).toContain("world");
    });

    it("captures console.error output", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'console.error("error message"); return true',
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.errors).toContain("error message");
    });

    it("captures console.warn output", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'console.warn("warning"); return true',
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.logs.some((log) => log.includes("warning"))).toBe(true);
    });

    it("captures console.info output", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'console.info("info message"); return true',
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.logs.some((log) => log.includes("info message"))).toBe(true);
    });

    it("returns duration", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return 42", aggregator, toolsByServer);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("tool calling", () => {
    it("can call tools from server namespace", async () => {
      const aggregator = createMockAggregator({
        read_file: { content: [{ type: "text", text: "file content" }] },
      });
      const toolsByServer = new Map([["filesystem", ["read_file"]]]);

      const result = await executeCodeMode(
        'const result = await filesystem.read_file({ path: "/test.txt" }); return result',
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].tool).toBe("filesystem.read_file");
      expect(aggregator.callTool).toHaveBeenCalledWith("read_file", { path: "/test.txt" });
    });

    it("records tool call duration", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map([["test", ["slow_tool"]]]);

      const result = await executeCodeMode(
        "await test.slow_tool({}); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.toolCalls[0].duration).toBeGreaterThanOrEqual(0);
    });

    it("records tool call result", async () => {
      const expectedResult = { data: "success" };
      const aggregator = createMockAggregator({
        my_tool: expectedResult,
      });
      const toolsByServer = new Map([["server", ["my_tool"]]]);

      const result = await executeCodeMode(
        "await server.my_tool({}); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.toolCalls[0].result).toEqual(expectedResult);
    });

    it("records tool call error", async () => {
      const aggregator = {
        callTool: vi.fn().mockRejectedValue(new Error("Tool failed")),
      } as unknown as Aggregator;
      const toolsByServer = new Map([["server", ["failing_tool"]]]);

      const result = await executeCodeMode(
        "try { await server.failing_tool({}); } catch(e) { return e.message; }",
        aggregator,
        toolsByServer,
      );

      expect(result.toolCalls[0].error).toBe("Tool failed");
    });

    it("can call multiple tools", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map([
        ["server1", ["tool1"]],
        ["server2", ["tool2"]],
      ]);

      const result = await executeCodeMode(
        "await server1.tool1({}); await server2.tool2({}); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].tool).toBe("server1.tool1");
      expect(result.toolCalls[1].tool).toBe("server2.tool2");
    });

    it("handles tool with no arguments", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map([["server", ["no_args_tool"]]]);

      const result = await executeCodeMode(
        "await server.no_args_tool(); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(aggregator.callTool).toHaveBeenCalledWith("no_args_tool", {});
    });
  });

  describe("error handling", () => {
    it("returns success=false on syntax error", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("invalid syntax {{{", aggregator, toolsByServer);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns success=false on runtime error", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        "throw new Error('intentional error')",
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes("intentional error"))).toBe(true);
    });

    it("returns success=false on undefined variable", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return undefinedVariable", aggregator, toolsByServer);

      expect(result.success).toBe(false);
    });
  });

  describe("data types", () => {
    it("handles string return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode('return "hello"', aggregator, toolsByServer);

      expect(result.result).toBe("hello");
    });

    it("handles number return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return 42.5", aggregator, toolsByServer);

      expect(result.result).toBe(42.5);
    });

    it("handles boolean return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return true", aggregator, toolsByServer);

      expect(result.result).toBe(true);
    });

    it("handles null return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return null", aggregator, toolsByServer);

      expect(result.result).toBe(null);
    });

    it("handles undefined return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return undefined", aggregator, toolsByServer);

      expect(result.result).toBe(undefined);
    });

    it("handles object return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'return { key: "value", num: 123 }',
        aggregator,
        toolsByServer,
      );

      expect(result.result).toEqual({ key: "value", num: 123 });
    });

    it("handles array return", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return [1, 2, 3]", aggregator, toolsByServer);

      expect(result.result).toEqual([1, 2, 3]);
    });
  });

  describe("console.log formatting", () => {
    it("formats multiple arguments", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'console.log("a", "b", "c"); return true',
        aggregator,
        toolsByServer,
      );

      expect(result.logs).toContain("a b c");
    });

    it("formats objects as JSON", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        'console.log({ key: "value" }); return true',
        aggregator,
        toolsByServer,
      );

      expect(result.logs[0]).toContain("key");
      expect(result.logs[0]).toContain("value");
    });

    it("formats undefined", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        "console.log(undefined); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.logs).toContain("undefined");
    });

    it("formats null", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        "console.log(null); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.logs).toContain("null");
    });

    it("formats numbers", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        "console.log(123); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.logs).toContain("123");
    });

    it("formats booleans", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        "console.log(true, false); return true",
        aggregator,
        toolsByServer,
      );

      expect(result.logs).toContain("true false");
    });
  });

  describe("async code", () => {
    it("supports async/await", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode(
        `
				const delay = () => new Promise(r => setTimeout(r, 10));
				await delay();
				return "done"
				`,
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe("done");
    });

    it("supports Promise.all", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map([["test", ["tool1", "tool2"]]]);

      const result = await executeCodeMode(
        `
				const results = await Promise.all([
					test.tool1({}),
					test.tool2({})
				]);
				return results.length
				`,
        aggregator,
        toolsByServer,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe(2);
    });
  });

  describe("configuration", () => {
    it("respects timeout configuration", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();
      const config: SandboxConfig = { timeout: 100 };

      const result = await executeCodeMode("while(true) {}", aggregator, toolsByServer, config);

      expect(result.success).toBe(false);
    }, 10000);

    it("uses default timeout when not specified", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return 1", aggregator, toolsByServer);

      expect(result.success).toBe(true);
    });
  });

  describe("no servers", () => {
    it("works with empty toolsByServer map", async () => {
      const aggregator = createMockAggregator();
      const toolsByServer = new Map<string, string[]>();

      const result = await executeCodeMode("return 2 * 3", aggregator, toolsByServer);

      expect(result.success).toBe(true);
      expect(result.result).toBe(6);
    });
  });
});
