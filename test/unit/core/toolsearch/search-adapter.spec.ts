import { describe, expect, it } from "vitest";
import type { ToolWithSource } from "../../../../src/core/aggregator.js";
import {
  searchToolCatalog,
  TOOL_SEARCH_MAX_CURSOR_LENGTH,
  ToolSearchCursorError,
} from "../../../../src/core/toolsearch/search-adapter.js";

function createTool(
  name: string,
  serverName: string,
  description: string,
  transport?: ToolWithSource["transport"],
): ToolWithSource {
  return {
    tool: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
      },
    },
    serverName,
    ...(transport ? { transport } : {}),
  };
}

describe("searchToolCatalog", () => {
  const createCatalog = () =>
    new Map<string, ToolWithSource>([
      ["zeta_write", createTool("write_file", "zeta", "Write a file", "stdio")],
      ["beta_lookup", createTool("lookup", "beta", "Find an invoice", "http-streamable")],
      ["alpha_echo", createTool("echo", "alpha", "Echo text", "stdio")],
    ]);

  it("matches literal text and supported qualifiers without applying fuzzy task ranking", () => {
    const catalog = createCatalog();
    catalog.set("translator", createTool("translate", "translator", "Translate text", "stdio"));

    expect(
      searchToolCatalog(catalog, "trnslate", { limit: 20, includeSchema: false }).results,
    ).toEqual([]);
    expect(
      searchToolCatalog(catalog, "server:beta transport:http-streamable invoice", {
        limit: 20,
        includeSchema: false,
      }).results.map(({ name }) => name),
    ).toEqual(["beta_lookup"]);
    expect(
      searchToolCatalog(catalog, "server:alpha", { limit: 20, includeSchema: false }).results.map(
        ({ name }) => name,
      ),
    ).toEqual(["alpha_echo"]);
  });

  it("pages deterministically and accepts a cursor only for the same query and options", () => {
    const catalog = createCatalog();
    const first = searchToolCatalog(catalog, "type:tool", { limit: 1, includeSchema: false });
    const second = searchToolCatalog(catalog, "type:tool", {
      cursor: first.nextCursor ?? undefined,
      limit: 1,
      includeSchema: false,
    });
    const third = searchToolCatalog(catalog, "type:tool", {
      cursor: second.nextCursor ?? undefined,
      limit: 1,
      includeSchema: false,
    });

    expect([first.results[0]?.name, second.results[0]?.name, third.results[0]?.name]).toEqual([
      "alpha_echo",
      "beta_lookup",
      "zeta_write",
    ]);
    expect(first.nextCursor).toBeTruthy();
    expect(second.nextCursor).toBeTruthy();
    expect(third.nextCursor).toBeNull();
    expect(() =>
      searchToolCatalog(catalog, "type:tool", {
        cursor: first.nextCursor ?? undefined,
        limit: 2,
        includeSchema: false,
      }),
    ).toThrow(ToolSearchCursorError);
    expect(() =>
      searchToolCatalog(catalog, "server:beta", {
        cursor: first.nextCursor ?? undefined,
        limit: 1,
        includeSchema: false,
      }),
    ).toThrow(ToolSearchCursorError);
  });

  it("rejects cursors after the authorized tool catalog changes", () => {
    const catalog = createCatalog();
    const first = searchToolCatalog(catalog, "type:tool", { limit: 1, includeSchema: false });
    const changedCatalog = new Map(catalog);
    changedCatalog.set("gamma_new", createTool("new_tool", "gamma", "A new tool", "stdio"));

    try {
      searchToolCatalog(changedCatalog, "type:tool", {
        cursor: first.nextCursor ?? undefined,
        limit: 1,
        includeSchema: false,
      });
      throw new Error("Expected a stale cursor to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSearchCursorError);
      expect((error as ToolSearchCursorError).stale).toBe(true);
    }
  });

  it("paginates the maximum-length quoted control-character query", () => {
    const queryText = "\u0001".repeat(2_046);
    const query = `"${queryText}"`;
    const catalog = new Map<string, ToolWithSource>([
      ["alpha_tool", createTool("alpha_tool", "alpha", queryText, "stdio")],
      ["beta_tool", createTool("beta_tool", "beta", queryText, "stdio")],
    ]);

    const first = searchToolCatalog(catalog, query, { limit: 1, includeSchema: false });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) return;

    expect(cursor.length).toBeLessThanOrEqual(TOOL_SEARCH_MAX_CURSOR_LENGTH);
    const second = searchToolCatalog(catalog, query, {
      cursor,
      limit: 1,
      includeSchema: false,
    });

    expect([...first.results, ...second.results].map(({ name }) => name).sort()).toEqual([
      "alpha_tool",
      "beta_tool",
    ]);
  });

  it("paginates catalog entries with long callable identities", () => {
    const identities = ["a", "b"].map((prefix) => `${prefix}${"x".repeat(20_000)}`);
    const catalog = new Map<string, ToolWithSource>(
      identities.map((identity) => [identity, createTool("echo", "server", "Echo text", "stdio")]),
    );

    const first = searchToolCatalog(catalog, "type:tool", { limit: 1, includeSchema: false });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) return;

    expect(cursor.length).toBeLessThanOrEqual(TOOL_SEARCH_MAX_CURSOR_LENGTH);
    const second = searchToolCatalog(catalog, "type:tool", {
      cursor,
      limit: 1,
      includeSchema: false,
    });

    expect([...first.results, ...second.results].map(({ name }) => name).sort()).toEqual(
      [...identities].sort(),
    );
  });

  it("includes input schemas only when explicitly requested and leaves OpenAPI transport unknown", () => {
    const catalog = new Map<string, ToolWithSource>([
      ["openapi_petstore_get_pet", createTool("get_pet", "openapi:petstore", "Find a pet")],
    ]);

    const defaultPage = searchToolCatalog(catalog, "petstore", { limit: 20, includeSchema: false });
    expect(defaultPage.results[0]).not.toHaveProperty("inputSchema");
    expect(defaultPage.results[0]).not.toHaveProperty("transport");

    const schemaPage = searchToolCatalog(catalog, "petstore", { limit: 20, includeSchema: true });
    expect(schemaPage.results[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(schemaPage.results[0]).not.toHaveProperty("transport");
    expect(
      searchToolCatalog(catalog, "transport:stdio", { limit: 20, includeSchema: false }).results,
    ).toEqual([]);
  });
});
