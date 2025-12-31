import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  Tool,
  Resource,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface MockToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;
}

export interface MockResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  handler: () => Promise<ReadResourceResult> | ReadResourceResult;
}

export interface MockPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  handler: (args?: Record<string, string>) => Promise<GetPromptResult> | GetPromptResult;
}

export interface MockMcpServerOptions {
  name?: string;
  version?: string;
  tools?: MockToolDefinition[];
  resources?: MockResourceDefinition[];
  prompts?: MockPromptDefinition[];
}

export interface MockMcpServer {
  server: Server;
  client: Client;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createMockMcpServer(options: MockMcpServerOptions = {}): MockMcpServer {
  const {
    name = "mock-server",
    version = "1.0.0",
    tools = [],
    resources = [],
    prompts = [],
  } = options;

  const server = new Server(
    { name, version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const toolMap = new Map<string, MockToolDefinition>();
  const resourceMap = new Map<string, MockResourceDefinition>();
  const promptMap = new Map<string, MockPromptDefinition>();

  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }
  for (const resource of resources) {
    resourceMap.set(resource.uri, resource);
  }
  for (const prompt of prompts) {
    promptMap.set(prompt.name, prompt);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    })) as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool not found: ${request.params.name}` }],
        isError: true,
      };
    }
    return tool.handler(request.params.arguments || {});
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })) as Resource[],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resourceMap.get(request.params.uri);
    if (!resource) {
      throw new Error(`Resource not found: ${request.params.uri}`);
    }
    return resource.handler();
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })) as Prompt[],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = promptMap.get(request.params.name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${request.params.name}`);
    }
    return prompt.handler(request.params.arguments);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  return {
    server,
    client,
    clientTransport,
    serverTransport,
    async start() {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    },
    async stop() {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

export function createEchoTool(): MockToolDefinition {
  return {
    name: "echo",
    description: "Echoes back the input message",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
    handler: (args) => ({
      content: [{ type: "text", text: String(args.message) }],
    }),
  };
}

export function createAddTool(): MockToolDefinition {
  return {
    name: "add",
    description: "Adds two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
    handler: (args) => ({
      content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }],
    }),
  };
}

export function createDelayTool(delayMs: number = 100): MockToolDefinition {
  return {
    name: "delay",
    description: `Waits for ${delayMs}ms then returns`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: [{ type: "text", text: "done" }],
      };
    },
  };
}

export function createErrorTool(): MockToolDefinition {
  return {
    name: "error",
    description: "Always throws an error",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
    },
    handler: (args) => {
      throw new Error(String(args.message) || "Test error");
    },
  };
}
