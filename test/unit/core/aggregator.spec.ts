import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Aggregator,
  type ToolWithSource,
  type ResourceWithSource,
  type PromptWithSource,
} from "../../../src/core/aggregator.js";
import type {
  UpstreamManager,
  UpstreamServer,
  UpstreamStatus,
} from "../../../src/core/upstream.js";
import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../../../src/config/types.js";

function createMockServer(
  name: string,
  options: {
    tools?: Tool[];
    resources?: Resource[];
    prompts?: Prompt[];
    config?: Partial<ServerConfig>;
    status?: UpstreamStatus;
  } = {},
): UpstreamServer {
  const config: ServerConfig = {
    transport: "stdio",
    command: "echo",
    ...options.config,
  };

  return {
    name,
    config,
    status: options.status ?? "discovered",
    client: null,
    cleanup: null,
    error: null,
    tools: options.tools ?? [],
    resources: options.resources ?? [],
    prompts: options.prompts ?? [],
    cachedTools: options.tools ?? [],
    cachedResources: options.resources ?? [],
    cachedPrompts: options.prompts ?? [],
    lastActivity: null,
    idleTimer: null,
    connectionPromise: null,
  };
}

function createMockUpstreamManager(servers: UpstreamServer[]): UpstreamManager {
  const serverMap = new Map(servers.map((s) => [s.name, s]));

  return {
    getDiscoveredOrConnected: () =>
      servers.filter((s) => s.status === "discovered" || s.status === "connected"),
    ensureConnected: vi.fn().mockImplementation(async (name: string) => {
      const server = serverMap.get(name);
      if (!server) throw new Error(`Server not found: ${name}`);
      return {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
        readResource: vi
          .fn()
          .mockResolvedValue({ contents: [{ uri: "test://resource", text: "content" }] }),
        getPrompt: vi
          .fn()
          .mockResolvedValue({
            messages: [{ role: "user", content: { type: "text", text: "prompt" } }],
          }),
      };
    }),
  } as unknown as UpstreamManager;
}

describe("Aggregator", () => {
  describe("refresh", () => {
    it("collects tools from all discovered servers", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "tool1", description: "Tool 1", inputSchema: { type: "object" } },
            { name: "tool2", description: "Tool 2", inputSchema: { type: "object" } },
          ],
        }),
        createMockServer("server2", {
          tools: [{ name: "tool3", description: "Tool 3", inputSchema: { type: "object" } }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(["tool1", "tool2", "tool3"]);
    });

    it("collects resources from all discovered servers", () => {
      const servers = [
        createMockServer("server1", {
          resources: [{ uri: "file:///path1", name: "Resource 1" }],
        }),
        createMockServer("server2", {
          resources: [{ uri: "file:///path2", name: "Resource 2" }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const resources = aggregator.getResources();
      expect(resources).toHaveLength(2);
      expect(resources.map((r) => r.uri)).toEqual(["file:///path1", "file:///path2"]);
    });

    it("collects prompts from all discovered servers", () => {
      const servers = [
        createMockServer("server1", {
          prompts: [{ name: "prompt1", description: "Prompt 1" }],
        }),
        createMockServer("server2", {
          prompts: [{ name: "prompt2", description: "Prompt 2" }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const prompts = aggregator.getPrompts();
      expect(prompts).toHaveLength(2);
      expect(prompts.map((p) => p.name)).toEqual(["prompt1", "prompt2"]);
    });

    it("throws on tool name collision", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "duplicate_tool", description: "Tool 1", inputSchema: { type: "object" } },
          ],
        }),
        createMockServer("server2", {
          tools: [
            { name: "duplicate_tool", description: "Tool 2", inputSchema: { type: "object" } },
          ],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      expect(() => aggregator.refresh()).toThrow(/duplicate_tool/);
    });

    it("throws on resource URI collision", () => {
      const servers = [
        createMockServer("server1", {
          resources: [{ uri: "file:///same/path", name: "Resource 1" }],
        }),
        createMockServer("server2", {
          resources: [{ uri: "file:///same/path", name: "Resource 2" }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      expect(() => aggregator.refresh()).toThrow();
    });

    it("throws on prompt name collision", () => {
      const servers = [
        createMockServer("server1", {
          prompts: [{ name: "same_prompt", description: "Prompt 1" }],
        }),
        createMockServer("server2", {
          prompts: [{ name: "same_prompt", description: "Prompt 2" }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      expect(() => aggregator.refresh()).toThrow();
    });

    it("ignores disabled servers", () => {
      const servers = [
        createMockServer("server1", {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
          status: "discovered",
        }),
        createMockServer("disabled", {
          tools: [{ name: "tool2", description: "Tool 2", inputSchema: { type: "object" } }],
          status: "disabled",
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("tool1");
    });

    it("clears previous state on refresh", () => {
      const servers = [
        createMockServer("server1", {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();
      expect(aggregator.getTools()).toHaveLength(1);

      servers[0].tools = [];
      servers[0].cachedTools = [];
      aggregator.refresh();
      expect(aggregator.getTools()).toHaveLength(0);
    });
  });

  describe("filtering", () => {
    it("applies allowedTools filter", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "allowed_tool", description: "Allowed", inputSchema: { type: "object" } },
            { name: "blocked_tool", description: "Blocked", inputSchema: { type: "object" } },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            allowedTools: ["allowed_tool"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("allowed_tool");
    });

    it("applies denyTools filter", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "safe_tool", description: "Safe", inputSchema: { type: "object" } },
            { name: "dangerous_tool", description: "Dangerous", inputSchema: { type: "object" } },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            denyTools: ["dangerous_tool"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("safe_tool");
    });

    it("applies allowedToolsGlob filter", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "read_file", description: "Read", inputSchema: { type: "object" } },
            { name: "read_dir", description: "Read Dir", inputSchema: { type: "object" } },
            { name: "write_file", description: "Write", inputSchema: { type: "object" } },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            allowedToolsGlob: ["read_*"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["read_file", "read_dir"]);
    });

    it("applies denyToolsGlob filter", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "read_file", description: "Read", inputSchema: { type: "object" } },
            { name: "delete_file", description: "Delete", inputSchema: { type: "object" } },
            { name: "delete_dir", description: "Delete Dir", inputSchema: { type: "object" } },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            denyToolsGlob: ["delete_*"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("read_file");
    });

    it("applies resource filters", () => {
      const servers = [
        createMockServer("server1", {
          resources: [
            { uri: "file:///safe/path", name: "Safe" },
            { uri: "file:///secret/path", name: "Secret" },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            denyResources: ["file:///secret/path"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const resources = aggregator.getResources();
      expect(resources).toHaveLength(1);
      expect(resources[0].uri).toBe("file:///safe/path");
    });

    it("applies prompt filters", () => {
      const servers = [
        createMockServer("server1", {
          prompts: [
            { name: "public_prompt", description: "Public" },
            { name: "admin_prompt", description: "Admin" },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            denyPromptsGlob: ["admin_*"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const prompts = aggregator.getPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("public_prompt");
    });

    it("deny takes precedence over allow", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "read_file", description: "Read", inputSchema: { type: "object" } },
            { name: "read_secret", description: "Secret", inputSchema: { type: "object" } },
          ],
          config: {
            transport: "stdio",
            command: "echo",
            allowedToolsGlob: ["read_*"],
            denyTools: ["read_secret"],
          },
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const tools = aggregator.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("read_file");
    });
  });

  describe("callTool", () => {
    it("routes tool call to correct server", async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "success" }],
        }),
      };

      const servers = [
        createMockServer("server1", {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
        }),
      ];

      const upstreamManager = {
        getDiscoveredOrConnected: () => servers,
        ensureConnected: vi.fn().mockResolvedValue(mockClient),
      } as unknown as UpstreamManager;

      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const result = await aggregator.callTool("tool1", { arg: "value" });

      expect(upstreamManager.ensureConnected).toHaveBeenCalledWith("server1");
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "tool1",
        arguments: { arg: "value" },
      });
      expect(result.content).toEqual([{ type: "text", text: "success" }]);
    });

    it("returns error for unknown tool", async () => {
      const servers: UpstreamServer[] = [];
      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      const result = await aggregator.callTool("nonexistent", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Tool not found"),
      });
    });

    it("returns error when upstream fails", async () => {
      const servers = [
        createMockServer("server1", {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
        }),
      ];

      const upstreamManager = {
        getDiscoveredOrConnected: () => servers,
        ensureConnected: vi.fn().mockRejectedValue(new Error("Connection failed")),
      } as unknown as UpstreamManager;

      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const result = await aggregator.callTool("tool1", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Connection failed"),
      });
    });
  });

  describe("readResource", () => {
    it("routes resource read to correct server", async () => {
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: "file:///path", text: "content" }],
        }),
      };

      const servers = [
        createMockServer("server1", {
          resources: [{ uri: "file:///path", name: "Resource" }],
        }),
      ];

      const upstreamManager = {
        getDiscoveredOrConnected: () => servers,
        ensureConnected: vi.fn().mockResolvedValue(mockClient),
      } as unknown as UpstreamManager;

      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const result = await aggregator.readResource("file:///path");

      expect(upstreamManager.ensureConnected).toHaveBeenCalledWith("server1");
      expect(mockClient.readResource).toHaveBeenCalledWith({ uri: "file:///path" });
      expect((result.contents[0] as { text: string }).text).toBe("content");
    });

    it("throws for unknown resource", async () => {
      const servers: UpstreamServer[] = [];
      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      await expect(aggregator.readResource("file:///unknown")).rejects.toThrow(
        "Resource not found",
      );
    });
  });

  describe("getPrompt", () => {
    it("routes prompt request to correct server", async () => {
      const mockClient = {
        getPrompt: vi.fn().mockResolvedValue({
          messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        }),
      };

      const servers = [
        createMockServer("server1", {
          prompts: [{ name: "greeting", description: "Greeting" }],
        }),
      ];

      const upstreamManager = {
        getDiscoveredOrConnected: () => servers,
        ensureConnected: vi.fn().mockResolvedValue(mockClient),
      } as unknown as UpstreamManager;

      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const result = await aggregator.getPrompt("greeting", { name: "World" });

      expect(upstreamManager.ensureConnected).toHaveBeenCalledWith("server1");
      expect(mockClient.getPrompt).toHaveBeenCalledWith({
        name: "greeting",
        arguments: { name: "World" },
      });
      expect(result.messages).toHaveLength(1);
    });

    it("throws for unknown prompt", async () => {
      const servers: UpstreamServer[] = [];
      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      await expect(aggregator.getPrompt("unknown")).rejects.toThrow("Prompt not found");
    });
  });

  describe("getStats", () => {
    it("returns correct counts", () => {
      const servers = [
        createMockServer("server1", {
          tools: [
            { name: "tool1", description: "Tool 1", inputSchema: { type: "object" } },
            { name: "tool2", description: "Tool 2", inputSchema: { type: "object" } },
          ],
          resources: [{ uri: "file:///path", name: "Resource" }],
          prompts: [
            { name: "prompt1", description: "Prompt 1" },
            { name: "prompt2", description: "Prompt 2" },
            { name: "prompt3", description: "Prompt 3" },
          ],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      aggregator.refresh();

      const stats = aggregator.getStats();
      expect(stats).toEqual({
        tools: 2,
        resources: 1,
        prompts: 3,
      });
    });

    it("returns zeros before refresh", () => {
      const servers: UpstreamServer[] = [];
      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      const stats = aggregator.getStats();
      expect(stats).toEqual({
        tools: 0,
        resources: 0,
        prompts: 0,
      });
    });
  });

  describe("initializeFromCache", () => {
    it("populates maps from cache", () => {
      const servers: UpstreamServer[] = [];
      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);

      const toolsCache = new Map<string, ToolWithSource>([
        [
          "tool1",
          {
            tool: { name: "tool1", description: "Tool 1", inputSchema: { type: "object" } },
            serverName: "server1",
          },
        ],
      ]);

      const resourcesCache = new Map<string, ResourceWithSource>([
        [
          "file:///path",
          { resource: { uri: "file:///path", name: "Resource" }, serverName: "server1" },
        ],
      ]);

      const promptsCache = new Map<string, PromptWithSource>([
        [
          "prompt1",
          { prompt: { name: "prompt1", description: "Prompt 1" }, serverName: "server1" },
        ],
      ]);

      aggregator.initializeFromCache({
        tools: toolsCache,
        resources: resourcesCache,
        prompts: promptsCache,
      });

      expect(aggregator.getTools()).toHaveLength(1);
      expect(aggregator.getResources()).toHaveLength(1);
      expect(aggregator.getPrompts()).toHaveLength(1);
    });
  });

  describe("getMaps", () => {
    it("returns tools map", () => {
      const servers = [
        createMockServer("server1", {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const toolsMap = aggregator.getToolsMap();
      expect(toolsMap.has("tool1")).toBe(true);
      expect(toolsMap.get("tool1")?.serverName).toBe("server1");
    });

    it("returns resources map", () => {
      const servers = [
        createMockServer("server1", {
          resources: [{ uri: "file:///path", name: "Resource" }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const resourcesMap = aggregator.getResourcesMap();
      expect(resourcesMap.has("file:///path")).toBe(true);
      expect(resourcesMap.get("file:///path")?.serverName).toBe("server1");
    });

    it("returns prompts map", () => {
      const servers = [
        createMockServer("server1", {
          prompts: [{ name: "prompt1", description: "Prompt 1" }],
        }),
      ];

      const upstreamManager = createMockUpstreamManager(servers);
      const aggregator = new Aggregator(upstreamManager);
      aggregator.refresh();

      const promptsMap = aggregator.getPromptsMap();
      expect(promptsMap.has("prompt1")).toBe(true);
      expect(promptsMap.get("prompt1")?.serverName).toBe("server1");
    });
  });
});
