import { describe, it, expect } from "vitest";
import {
	generateTypeScriptDefinitions,
	groupToolsByServer,
	toolsToToolInfo,
	type ToolInfo,
} from "../../../../src/core/codemode/codegen.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

describe("generateTypeScriptDefinitions", () => {
	it("generates declarations for simple tools", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "filesystem",
				name: "read_file",
				description: "Read a file",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path" },
					},
					required: ["path"],
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("declare const filesystem:");
		expect(result).toContain("read_file:");
		expect(result).toContain("/** Read a file */");
		expect(result).toContain("path: string");
		expect(result).toContain("Promise<any>");
	});

	it("generates declarations for multiple servers", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "filesystem",
				name: "read_file",
				description: "Read a file",
				inputSchema: { type: "object", properties: {} },
			},
			{
				serverName: "git",
				name: "commit",
				description: "Create a commit",
				inputSchema: { type: "object", properties: {} },
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("declare const filesystem:");
		expect(result).toContain("declare const git:");
		expect(result).toContain("read_file:");
		expect(result).toContain("commit:");
	});

	it("handles optional parameters", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "api",
				name: "fetch_data",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						url: { type: "string" },
						timeout: { type: "number" },
					},
					required: ["url"],
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("url: string");
		expect(result).toContain("timeout?: number");
	});

	it("handles enum types", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "git",
				name: "list_issues",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						state: {
							type: "string",
							enum: ["open", "closed", "all"],
						},
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain('"open" | "closed" | "all"');
	});

	it("handles array types", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "batch",
				name: "process",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						items: { type: "array", items: { type: "string" } },
						numbers: { type: "array", items: { type: "number" } },
						any_array: { type: "array" },
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("items?: string[]");
		expect(result).toContain("numbers?: number[]");
		expect(result).toContain("any_array?: any[]");
	});

	it("handles nested object types", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "api",
				name: "create",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						config: {
							type: "object",
							properties: {
								name: { type: "string" },
								value: { type: "number" },
							},
							required: ["name"],
						},
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("config?: { name: string; value?: number }");
	});

	it("handles boolean type", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "toggle",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						enabled: { type: "boolean" },
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("enabled?: boolean");
	});

	it("handles null type", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "nullable",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						value: { type: "null" },
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("value?: null");
	});

	it("handles integer type as number", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "count",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						count: { type: "integer" },
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("count?: number");
	});

	it("handles unknown type as any", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "unknown",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						data: { type: "unknown_type" },
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("data?: any");
	});

	it("handles missing type as any", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "noType",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						data: {},
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("data?: any");
	});

	it("handles empty schema", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "noArgs",
				description: null,
				inputSchema: {},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("Record<string, any>");
	});

	it("handles null schema", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "nullSchema",
				description: null,
				inputSchema: null,
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("Record<string, any>");
	});

	it("escapes JSDoc special characters", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "escapeTest",
				description: "Description with */ and\nnewlines",
				inputSchema: { type: "object", properties: {} },
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("/** Description with * / and newlines */");
		expect(result).not.toContain("Description with */");
	});

	it("handles tool names that need quoting", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "tool-with-dashes",
				description: null,
				inputSchema: { type: "object", properties: {} },
			},
			{
				serverName: "test",
				name: "tool.with.dots",
				description: null,
				inputSchema: { type: "object", properties: {} },
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain('"tool-with-dashes":');
		expect(result).toContain('"tool.with.dots":');
	});

	it("does not quote valid identifiers", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "validName",
				description: null,
				inputSchema: { type: "object", properties: {} },
			},
			{
				serverName: "test",
				name: "_underscore",
				description: null,
				inputSchema: { type: "object", properties: {} },
			},
			{
				serverName: "test",
				name: "$dollar",
				description: null,
				inputSchema: { type: "object", properties: {} },
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("validName:");
		expect(result).toContain("_underscore:");
		expect(result).toContain("$dollar:");
		expect(result).not.toContain('"validName"');
	});

	it("includes built-in function declarations", () => {
		const tools: ToolInfo[] = [];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("declare function fetch");
		expect(result).toContain("declare const console:");
		expect(result).toContain("log:");
		expect(result).toContain("error:");
		expect(result).toContain("warn:");
	});

	it("handles property descriptions in args", () => {
		const tools: ToolInfo[] = [
			{
				serverName: "test",
				name: "documented",
				description: null,
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "The file path to read" },
					},
				},
			},
		];

		const result = generateTypeScriptDefinitions(tools);

		expect(result).toContain("/** The file path to read */");
	});
});

describe("groupToolsByServer", () => {
	it("groups tools by server name", () => {
		const tools: ToolInfo[] = [
			{ serverName: "server1", name: "tool1", description: null, inputSchema: {} },
			{ serverName: "server1", name: "tool2", description: null, inputSchema: {} },
			{ serverName: "server2", name: "tool3", description: null, inputSchema: {} },
		];

		const result = groupToolsByServer(tools);

		expect(result.get("server1")).toEqual(["tool1", "tool2"]);
		expect(result.get("server2")).toEqual(["tool3"]);
	});

	it("handles empty array", () => {
		const result = groupToolsByServer([]);

		expect(result.size).toBe(0);
	});

	it("handles single tool", () => {
		const tools: ToolInfo[] = [
			{ serverName: "server", name: "tool", description: null, inputSchema: {} },
		];

		const result = groupToolsByServer(tools);

		expect(result.get("server")).toEqual(["tool"]);
	});
});

describe("toolsToToolInfo", () => {
	it("converts tools map to ToolInfo array", () => {
		const toolsMap = new Map<string, { tool: Tool; serverName: string }>([
			[
				"read_file",
				{
					tool: {
						name: "read_file",
						description: "Read a file",
						inputSchema: { type: "object" },
					},
					serverName: "filesystem",
				},
			],
			[
				"commit",
				{
					tool: {
						name: "commit",
						description: "Create commit",
						inputSchema: { type: "object" },
					},
					serverName: "git",
				},
			],
		]);

		const result = toolsToToolInfo(toolsMap);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			serverName: "filesystem",
			name: "read_file",
			description: "Read a file",
			inputSchema: { type: "object" },
		});
	});

	it("handles tool without description", () => {
		const toolsMap = new Map<string, { tool: Tool; serverName: string }>([
			[
				"tool",
				{
					tool: {
						name: "tool",
						inputSchema: { type: "object" },
					},
					serverName: "server",
				},
			],
		]);

		const result = toolsToToolInfo(toolsMap);

		expect(result[0].description).toBeNull();
	});

	it("handles empty map", () => {
		const result = toolsToToolInfo(new Map());

		expect(result).toEqual([]);
	});
});
