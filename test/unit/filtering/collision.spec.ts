import { describe, expect, it } from "vitest";
import {
  checkAllCollisions,
  disambiguateNames,
  type ItemWithSource,
} from "../../../src/filtering/collision.js";

describe("checkAllCollisions", () => {
  describe("tool collisions", () => {
    it("throws error when tools have same name from different servers", () => {
      const tools: ItemWithSource[] = [
        { name: "read_file", serverName: "server1" },
        { name: "read_file", serverName: "server2" },
      ];

      expect(() => checkAllCollisions({ tools, resources: [], prompts: [] })).toThrow();
    });

    it("includes collision details in error message", () => {
      const tools: ItemWithSource[] = [
        { name: "read_file", serverName: "server1" },
        { name: "read_file", serverName: "server2" },
      ];

      try {
        checkAllCollisions({ tools, resources: [], prompts: [] });
        expect.fail("Expected error to be thrown");
      } catch (error) {
        expect((error as Error).message).toContain("read_file");
        expect((error as Error).message).toContain("server1");
        expect((error as Error).message).toContain("server2");
      }
    });

    it("allows same tool name from same server", () => {
      const tools: ItemWithSource[] = [
        { name: "read_file", serverName: "server1" },
        { name: "write_file", serverName: "server1" },
      ];

      expect(() => checkAllCollisions({ tools, resources: [], prompts: [] })).not.toThrow();
    });

    it("allows unique tool names from different servers", () => {
      const tools: ItemWithSource[] = [
        { name: "read_file", serverName: "server1" },
        { name: "write_file", serverName: "server2" },
        { name: "delete_file", serverName: "server3" },
      ];

      expect(() => checkAllCollisions({ tools, resources: [], prompts: [] })).not.toThrow();
    });
  });

  describe("resource collisions", () => {
    it("throws error when resources have same URI from different servers", () => {
      const resources: ItemWithSource[] = [
        { name: "file:///path/to/file", serverName: "server1" },
        { name: "file:///path/to/file", serverName: "server2" },
      ];

      expect(() => checkAllCollisions({ tools: [], resources, prompts: [] })).toThrow();
    });

    it("allows unique resource URIs", () => {
      const resources: ItemWithSource[] = [
        { name: "file:///path1", serverName: "server1" },
        { name: "file:///path2", serverName: "server2" },
      ];

      expect(() => checkAllCollisions({ tools: [], resources, prompts: [] })).not.toThrow();
    });
  });

  describe("prompt collisions", () => {
    it("throws error when prompts have same name from different servers", () => {
      const prompts: ItemWithSource[] = [
        { name: "commit_message", serverName: "server1" },
        { name: "commit_message", serverName: "server2" },
      ];

      expect(() => checkAllCollisions({ tools: [], resources: [], prompts })).toThrow();
    });

    it("allows unique prompt names", () => {
      const prompts: ItemWithSource[] = [
        { name: "commit_message", serverName: "server1" },
        { name: "pr_description", serverName: "server2" },
      ];

      expect(() => checkAllCollisions({ tools: [], resources: [], prompts })).not.toThrow();
    });
  });

  describe("multiple collision types", () => {
    it("detects collisions across all types simultaneously", () => {
      const tools: ItemWithSource[] = [
        { name: "tool1", serverName: "server1" },
        { name: "tool1", serverName: "server2" },
      ];
      const resources: ItemWithSource[] = [
        { name: "resource1", serverName: "server1" },
        { name: "resource1", serverName: "server2" },
      ];
      const prompts: ItemWithSource[] = [
        { name: "prompt1", serverName: "server1" },
        { name: "prompt1", serverName: "server2" },
      ];

      try {
        checkAllCollisions({ tools, resources, prompts });
        expect.fail("Expected error to be thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("tool");
        expect(message).toContain("resource");
        expect(message).toContain("prompt");
      }
    });

    it("passes when no collisions exist", () => {
      const tools: ItemWithSource[] = [
        { name: "tool1", serverName: "server1" },
        { name: "tool2", serverName: "server2" },
      ];
      const resources: ItemWithSource[] = [
        { name: "resource1", serverName: "server1" },
        { name: "resource2", serverName: "server2" },
      ];
      const prompts: ItemWithSource[] = [
        { name: "prompt1", serverName: "server1" },
        { name: "prompt2", serverName: "server2" },
      ];

      expect(() => checkAllCollisions({ tools, resources, prompts })).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("handles empty arrays", () => {
      expect(() => checkAllCollisions({ tools: [], resources: [], prompts: [] })).not.toThrow();
    });

    it("handles single item arrays", () => {
      const tools: ItemWithSource[] = [{ name: "tool1", serverName: "server1" }];
      expect(() => checkAllCollisions({ tools, resources: [], prompts: [] })).not.toThrow();
    });

    it("detects multiple collisions for same name", () => {
      const tools: ItemWithSource[] = [
        { name: "shared_tool", serverName: "server1" },
        { name: "shared_tool", serverName: "server2" },
        { name: "shared_tool", serverName: "server3" },
      ];

      try {
        checkAllCollisions({ tools, resources: [], prompts: [] });
        expect.fail("Expected error to be thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("shared_tool");
        expect(message).toContain("server1");
        expect(message).toContain("server2");
        expect(message).toContain("server3");
      }
    });
  });
});

describe("disambiguateNames", () => {
  it("returns same names when no collisions", () => {
    const items: ItemWithSource[] = [
      { name: "read_file", serverName: "server1" },
      { name: "write_file", serverName: "server2" },
    ];
    expect(disambiguateNames(items)).toEqual(["read_file", "write_file"]);
  });

  it("keeps first occurrence and suffixes others with 4-char id", () => {
    const items: ItemWithSource[] = [
      { name: "read_file", serverName: "server1" },
      { name: "read_file", serverName: "server2" },
    ];
    const result = disambiguateNames(items);
    expect(result[0]).toBe("read_file");
    expect(result[1]).toMatch(/^read_file_[0-9a-f]{4}$/);
  });

  it("is deterministic for same (name, serverName)", () => {
    const items: ItemWithSource[] = [
      { name: "x", serverName: "a" },
      { name: "x", serverName: "b" },
    ];
    const a = disambiguateNames(items);
    const b = disambiguateNames(items);
    expect(a).toEqual(b);
  });
});
