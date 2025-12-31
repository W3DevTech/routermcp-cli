import { describe, expect, it } from "vitest";
import type { FilterConfig } from "../../../src/config/types.js";
import {
  filterItems,
  getPromptFilter,
  getResourceFilter,
  getToolFilter,
  shouldAllow,
} from "../../../src/filtering/filter.js";

describe("shouldAllow", () => {
  describe("deny rules (highest precedence)", () => {
    it("denies exact match in deny list", () => {
      const filter: FilterConfig = { deny: ["delete_file", "dangerous_tool"] };
      expect(shouldAllow("delete_file", filter)).toBe(false);
      expect(shouldAllow("dangerous_tool", filter)).toBe(false);
    });

    it("denies items matching denyGlob patterns", () => {
      const filter: FilterConfig = { denyGlob: ["delete_*", "*_admin"] };
      expect(shouldAllow("delete_file", filter)).toBe(false);
      expect(shouldAllow("delete_user", filter)).toBe(false);
      expect(shouldAllow("system_admin", filter)).toBe(false);
    });

    it("deny takes precedence over allow", () => {
      const filter: FilterConfig = {
        allowed: ["delete_file"],
        deny: ["delete_file"],
      };
      expect(shouldAllow("delete_file", filter)).toBe(false);
    });

    it("denyGlob takes precedence over allowedGlob", () => {
      const filter: FilterConfig = {
        allowedGlob: ["delete_*"],
        denyGlob: ["delete_secret"],
      };
      expect(shouldAllow("delete_file", filter)).toBe(true);
      expect(shouldAllow("delete_secret", filter)).toBe(false);
    });
  });

  describe("allow rules", () => {
    it("allows exact match in allowed list", () => {
      const filter: FilterConfig = { allowed: ["read_file", "list_files"] };
      expect(shouldAllow("read_file", filter)).toBe(true);
      expect(shouldAllow("list_files", filter)).toBe(true);
    });

    it("allows items matching allowedGlob patterns", () => {
      const filter: FilterConfig = { allowedGlob: ["read_*", "get_*"] };
      expect(shouldAllow("read_file", filter)).toBe(true);
      expect(shouldAllow("read_dir", filter)).toBe(true);
      expect(shouldAllow("get_user", filter)).toBe(true);
    });

    it("denies items not matching any allow rule when allow rules are defined", () => {
      const filter: FilterConfig = { allowed: ["read_file"] };
      expect(shouldAllow("write_file", filter)).toBe(false);
    });

    it("denies items not matching allowedGlob when defined", () => {
      const filter: FilterConfig = { allowedGlob: ["read_*"] };
      expect(shouldAllow("write_file", filter)).toBe(false);
    });
  });

  describe("default behavior (no rules)", () => {
    it("allows all when no rules defined", () => {
      const filter: FilterConfig = {};
      expect(shouldAllow("anything", filter)).toBe(true);
      expect(shouldAllow("delete_everything", filter)).toBe(true);
    });

    it("allows all when rules are empty arrays", () => {
      const filter: FilterConfig = {
        allowed: [],
        deny: [],
        allowedGlob: [],
        denyGlob: [],
      };
      expect(shouldAllow("anything", filter)).toBe(true);
    });
  });

  describe("complex filter combinations", () => {
    it("handles mixed exact and glob patterns", () => {
      const filter: FilterConfig = {
        allowed: ["special_tool"],
        allowedGlob: ["read_*"],
        deny: ["read_secret"],
        denyGlob: ["*_admin"],
      };

      expect(shouldAllow("special_tool", filter)).toBe(true);
      expect(shouldAllow("read_file", filter)).toBe(true);
      expect(shouldAllow("read_secret", filter)).toBe(false);
      expect(shouldAllow("system_admin", filter)).toBe(false);
      expect(shouldAllow("write_file", filter)).toBe(false);
    });

    it("handles wildcard patterns", () => {
      const filter: FilterConfig = { allowedGlob: ["**"] };
      expect(shouldAllow("anything", filter)).toBe(true);
    });

    it("handles brace expansion in patterns", () => {
      const filter: FilterConfig = { allowedGlob: ["{read,write}_file"] };
      expect(shouldAllow("read_file", filter)).toBe(true);
      expect(shouldAllow("write_file", filter)).toBe(true);
      expect(shouldAllow("delete_file", filter)).toBe(false);
    });
  });
});

describe("getToolFilter", () => {
  it("extracts tool filter config from server config", () => {
    const serverConfig = {
      allowedTools: ["tool1", "tool2"],
      denyTools: ["tool3"],
      allowedToolsGlob: ["get_*"],
      denyToolsGlob: ["*_admin"],
    };

    const filter = getToolFilter(serverConfig);

    expect(filter.allowed).toEqual(["tool1", "tool2"]);
    expect(filter.deny).toEqual(["tool3"]);
    expect(filter.allowedGlob).toEqual(["get_*"]);
    expect(filter.denyGlob).toEqual(["*_admin"]);
  });

  it("handles empty server config", () => {
    const filter = getToolFilter({});

    expect(filter.allowed).toBeUndefined();
    expect(filter.deny).toBeUndefined();
    expect(filter.allowedGlob).toBeUndefined();
    expect(filter.denyGlob).toBeUndefined();
  });
});

describe("getResourceFilter", () => {
  it("extracts resource filter config from server config", () => {
    const serverConfig = {
      allowedResources: ["file:///safe/path"],
      denyResources: ["file:///secret"],
      allowedResourcesGlob: ["https://*.example.com/*"],
      denyResourcesGlob: ["**/private/**"],
    };

    const filter = getResourceFilter(serverConfig);

    expect(filter.allowed).toEqual(["file:///safe/path"]);
    expect(filter.deny).toEqual(["file:///secret"]);
    expect(filter.allowedGlob).toEqual(["https://*.example.com/*"]);
    expect(filter.denyGlob).toEqual(["**/private/**"]);
  });
});

describe("getPromptFilter", () => {
  it("extracts prompt filter config from server config", () => {
    const serverConfig = {
      allowedPrompts: ["commit_message"],
      denyPrompts: ["admin_prompt"],
      allowedPromptsGlob: ["public_*"],
      denyPromptsGlob: ["*_secret"],
    };

    const filter = getPromptFilter(serverConfig);

    expect(filter.allowed).toEqual(["commit_message"]);
    expect(filter.deny).toEqual(["admin_prompt"]);
    expect(filter.allowedGlob).toEqual(["public_*"]);
    expect(filter.denyGlob).toEqual(["*_secret"]);
  });
});

describe("filterItems", () => {
  it("filters array of items based on filter config", () => {
    const items = [
      { name: "read_file" },
      { name: "write_file" },
      { name: "delete_file" },
      { name: "admin_tool" },
    ];

    const filter: FilterConfig = {
      allowedGlob: ["read_*", "write_*"],
      denyGlob: ["*_admin"],
    };

    const filtered = filterItems(items, filter);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((i) => i.name)).toEqual(["read_file", "write_file"]);
  });

  it("returns all items when no filters defined", () => {
    const items = [{ name: "tool1" }, { name: "tool2" }, { name: "tool3" }];
    const filtered = filterItems(items, {});

    expect(filtered).toHaveLength(3);
  });

  it("returns empty array when all items are filtered out", () => {
    const items = [{ name: "admin_tool" }, { name: "secret_tool" }];
    const filter: FilterConfig = { denyGlob: ["*"] };

    const filtered = filterItems(items, filter);

    expect(filtered).toHaveLength(0);
  });
});
