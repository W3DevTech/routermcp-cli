import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  findConfigFile,
  loadConfig,
  saveConfig,
  getDefaultConfigPath,
  createDefaultConfig,
} from "../src/lib/config-loader.ts";

const TEST_DIR = "/tmp/routermcp-test-config";

describe("config-loader", () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("findConfigFile", () => {
    it("should find routermcp.json", () => {
      const configPath = join(TEST_DIR, "routermcp.json");
      writeFileSync(configPath, "{}");
      const found = findConfigFile(TEST_DIR);
      expect(found).toBe(configPath);
    });

    it("should find routermcp.jsonc", () => {
      const configPath = join(TEST_DIR, "routermcp.jsonc");
      writeFileSync(configPath, "{}");
      const found = findConfigFile(TEST_DIR);
      expect(found).toBe(configPath);
    });

    it("should prefer routermcp.jsonc over routermcp.json", () => {
      writeFileSync(join(TEST_DIR, "routermcp.json"), "{}");
      const jsoncPath = join(TEST_DIR, "routermcp.jsonc");
      writeFileSync(jsoncPath, "{}");
      const found = findConfigFile(TEST_DIR);
      expect(found).toBe(jsoncPath);
    });

    it("should return null when no config file exists", () => {
      const found = findConfigFile(TEST_DIR);
      expect(found).toBeNull();
    });
  });

  describe("loadConfig", () => {
    it("should load and parse a valid JSON config", () => {
      const configPath = join(TEST_DIR, "routermcp.json");
      const configContent = {
        mcpServers: {
          test: {
            transport: "local" as const,
            command: "echo",
            args: ["hello"],
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(configContent));
      const config = loadConfig(configPath);
      expect(config).toEqual(configContent);
    });

    it("should load and parse a valid JSONC config with comments", () => {
      const configPath = join(TEST_DIR, "routermcp.jsonc");
      const configContent = `{
        // This is a comment
        "mcpServers": {
          "test": {
            "transport": "local",
            "command": "echo"
          }
        }
      }`;
      writeFileSync(configPath, configContent);
      const config = loadConfig(configPath);
      expect(config.mcpServers.test?.transport).toBe("local");
    });

    it("should throw an error for invalid config structure", () => {
      const configPath = join(TEST_DIR, "routermcp.json");
      writeFileSync(configPath, JSON.stringify({ invalid: true }));
      expect(() => loadConfig(configPath)).toThrow(
        '"mcpServers" must be an object'
      );
    });
  });

  describe("saveConfig", () => {
    it("should save config to a file", () => {
      const configPath = join(TEST_DIR, "routermcp.json");
      const config = createDefaultConfig();
      config.mcpServers.test = {
        transport: "local",
        command: "echo",
      };
      saveConfig(configPath, config);

      const savedContent = JSON.parse(
        require("fs").readFileSync(configPath, "utf-8")
      );
      expect(savedContent.mcpServers.test.command).toBe("echo");
    });
  });

  describe("getDefaultConfigPath", () => {
    it("should return path to routermcp.json in given directory", () => {
      const result = getDefaultConfigPath(TEST_DIR);
      expect(result).toBe(join(TEST_DIR, "routermcp.json"));
    });
  });

  describe("createDefaultConfig", () => {
    it("should create an empty config with mcpServers object", () => {
      const config = createDefaultConfig();
      expect(config).toEqual({ mcpServers: {} });
    });
  });
});
