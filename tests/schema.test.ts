/**
 * Tests for configuration schema validation
 */

import { describe, test, expect } from "bun:test";
import { routerMcpConfigSchema, serverConfigSchema } from "../src/config/schema.js";

describe("serverConfigSchema", () => {
  test("validates stdio config", () => {
    const config = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-package"],
    };
    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("requires command for stdio transport", () => {
    const config = {
      transport: "stdio",
    };
    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("validates http-streamable config", () => {
    const config = {
      transport: "http-streamable",
      url: "http://localhost:3001/mcp",
    };
    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("requires url for http-streamable transport", () => {
    const config = {
      transport: "http-streamable",
    };
    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("validates filter arrays", () => {
    const config = {
      transport: "stdio",
      command: "test",
      allowedTools: ["tool1", "tool2"],
      denyToolsGlob: ["*_delete_*"],
    };
    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects invalid transport", () => {
    const config = {
      transport: "websocket",
      command: "test",
    };
    const result = serverConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("routerMcpConfigSchema", () => {
  test("validates full config", () => {
    const config = {
      mcpServers: {
        server1: {
          transport: "stdio",
          command: "npx",
        },
        server2: {
          transport: "http-streamable",
          url: "http://localhost:3000",
        },
      },
    };
    const result = routerMcpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("validates empty servers", () => {
    const config = {
      mcpServers: {},
    };
    const result = routerMcpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects missing mcpServers", () => {
    const config = {};
    const result = routerMcpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
