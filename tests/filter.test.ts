/**
 * Tests for filtering logic
 */

import { describe, test, expect } from "bun:test";
import {
  isAllowed,
  filterItems,
  getToolFilterConfig,
  getResourceFilterConfig,
  getPromptFilterConfig,
} from "../src/filtering/filter.js";
import type { FilterConfig } from "../src/config/types.js";

describe("isAllowed", () => {
  test("allows everything with no filter config", () => {
    const config: FilterConfig = {};
    expect(isAllowed("anything", config)).toBe(true);
  });

  test("denies exact match in deny list", () => {
    const config: FilterConfig = { deny: ["blocked"] };
    expect(isAllowed("blocked", config)).toBe(false);
    expect(isAllowed("allowed", config)).toBe(true);
  });

  test("denies glob match in deny list", () => {
    const config: FilterConfig = { denyGlob: ["*_delete_*"] };
    expect(isAllowed("file_delete_all", config)).toBe(false);
    expect(isAllowed("file_read", config)).toBe(true);
  });

  test("allows exact match in allow list", () => {
    const config: FilterConfig = { allowed: ["read_file"] };
    expect(isAllowed("read_file", config)).toBe(true);
    expect(isAllowed("write_file", config)).toBe(false);
  });

  test("allows glob match in allow list", () => {
    const config: FilterConfig = { allowedGlob: ["read_*"] };
    expect(isAllowed("read_file", config)).toBe(true);
    expect(isAllowed("read_directory", config)).toBe(true);
    expect(isAllowed("write_file", config)).toBe(false);
  });

  test("deny takes precedence over allow", () => {
    const config: FilterConfig = {
      allowed: ["read_file", "write_file"],
      deny: ["write_file"],
    };
    expect(isAllowed("read_file", config)).toBe(true);
    expect(isAllowed("write_file", config)).toBe(false);
  });

  test("deny glob takes precedence over allow", () => {
    const config: FilterConfig = {
      allowed: ["read_file", "delete_file"],
      denyGlob: ["delete_*"],
    };
    expect(isAllowed("read_file", config)).toBe(true);
    expect(isAllowed("delete_file", config)).toBe(false);
  });

  test("combined allow list and glob", () => {
    const config: FilterConfig = {
      allowed: ["special_tool"],
      allowedGlob: ["read_*"],
    };
    expect(isAllowed("special_tool", config)).toBe(true);
    expect(isAllowed("read_file", config)).toBe(true);
    expect(isAllowed("write_file", config)).toBe(false);
  });
});

describe("filterItems", () => {
  const items = [
    { name: "read_file" },
    { name: "write_file" },
    { name: "delete_file" },
    { name: "list_directory" },
  ];

  test("filters items based on config", () => {
    const config: FilterConfig = {
      allowed: ["read_file", "list_directory"],
    };
    const result = filterItems(items, config);
    expect(result.map((i) => i.name)).toEqual(["read_file", "list_directory"]);
  });

  test("returns all items with no filter", () => {
    const result = filterItems(items, {});
    expect(result).toEqual(items);
  });
});

describe("getToolFilterConfig", () => {
  test("maps server config to filter config", () => {
    const serverConfig = {
      allowedTools: ["tool1"],
      denyTools: ["tool2"],
      allowedToolsGlob: ["read_*"],
      denyToolsGlob: ["*_delete"],
    };
    const result = getToolFilterConfig(serverConfig);
    expect(result).toEqual({
      allowed: ["tool1"],
      deny: ["tool2"],
      allowedGlob: ["read_*"],
      denyGlob: ["*_delete"],
    });
  });
});

describe("getResourceFilterConfig", () => {
  test("maps server config to filter config", () => {
    const serverConfig = {
      allowedResources: ["file:///allowed"],
      denyResources: ["file:///denied"],
    };
    const result = getResourceFilterConfig(serverConfig);
    expect(result).toEqual({
      allowed: ["file:///allowed"],
      deny: ["file:///denied"],
      allowedGlob: undefined,
      denyGlob: undefined,
    });
  });
});

describe("getPromptFilterConfig", () => {
  test("maps server config to filter config", () => {
    const serverConfig = {
      allowedPrompts: ["prompt1"],
      denyPromptsGlob: ["admin_*"],
    };
    const result = getPromptFilterConfig(serverConfig);
    expect(result).toEqual({
      allowed: ["prompt1"],
      deny: undefined,
      allowedGlob: undefined,
      denyGlob: ["admin_*"],
    });
  });
});
