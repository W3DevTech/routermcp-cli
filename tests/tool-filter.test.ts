import { describe, expect, it } from "bun:test";
import { filterTools } from "../src/lib/tool-filter.ts";
import type { ToolInfo, McpServerToolFilter } from "../src/types.ts";

const mockTools: ToolInfo[] = [
  { name: "db:query", description: "Query the database" },
  { name: "db:insert", description: "Insert into database" },
  { name: "git:commit", description: "Commit changes" },
  { name: "git:push", description: "Push changes" },
  { name: "admin:delete", description: "Delete admin" },
  { name: "admin:create", description: "Create admin" },
  { name: "read_file", description: "Read a file" },
  { name: "write_file", description: "Write a file" },
];

describe("filterTools", () => {
  it("should return all tools when no filters are set", () => {
    const filter: McpServerToolFilter = {};
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(8);
    expect(result).toEqual(mockTools);
  });

  it("should filter by allowedTools", () => {
    const filter: McpServerToolFilter = {
      allowedTools: ["db:query", "read_file"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(["db:query", "read_file"]);
  });

  it("should filter by denyTools", () => {
    const filter: McpServerToolFilter = {
      denyTools: ["admin:delete", "admin:create"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(6);
    expect(result.map((t) => t.name)).not.toContain("admin:delete");
    expect(result.map((t) => t.name)).not.toContain("admin:create");
  });

  it("should filter by allowedToolsGlob", () => {
    const filter: McpServerToolFilter = {
      allowedToolsGlob: ["db:*"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(["db:query", "db:insert"]);
  });

  it("should filter by denyToolsGlob", () => {
    const filter: McpServerToolFilter = {
      denyToolsGlob: ["admin:*"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(6);
    expect(result.map((t) => t.name)).not.toContain("admin:delete");
    expect(result.map((t) => t.name)).not.toContain("admin:create");
  });

  it("should combine allowedToolsGlob patterns", () => {
    const filter: McpServerToolFilter = {
      allowedToolsGlob: ["db:*", "git:*"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(4);
    expect(result.map((t) => t.name)).toEqual([
      "db:query",
      "db:insert",
      "git:commit",
      "git:push",
    ]);
  });

  it("should give deny precedence over allow", () => {
    const filter: McpServerToolFilter = {
      allowedTools: ["db:query", "db:insert", "admin:delete"],
      denyTools: ["admin:delete"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(["db:query", "db:insert"]);
  });

  it("should combine allowedTools and allowedToolsGlob", () => {
    const filter: McpServerToolFilter = {
      allowedTools: ["read_file"],
      allowedToolsGlob: ["git:*"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual([
      "git:commit",
      "git:push",
      "read_file",
    ]);
  });

  it("should give denyToolsGlob precedence over allowedToolsGlob", () => {
    const filter: McpServerToolFilter = {
      allowedToolsGlob: ["*:*"],
      denyToolsGlob: ["admin:*"],
    };
    const result = filterTools(mockTools, filter);
    expect(result).toHaveLength(4);
    expect(result.map((t) => t.name)).toEqual([
      "db:query",
      "db:insert",
      "git:commit",
      "git:push",
    ]);
  });
});
