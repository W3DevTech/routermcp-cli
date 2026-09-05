import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findConfigFile,
  getConfigLocations,
  loadConfig,
  loadConfigFromPath,
  resolveConfigPathForScope,
} from "../../../src/config/loader.js";
import {
  getLegacyProjectId,
  getProjectId,
  getUserProjectConfigPath,
} from "../../../src/daemon/project.js";
import { cleanupTempDir, createTempDir } from "../../helpers/test-utils.js";

describe("findConfigFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("finds routermcp.jsonc file", async () => {
    const configPath = join(tempDir, "routermcp.jsonc");
    await writeFile(configPath, '{"mcpServers":{}}');

    const result = await findConfigFile(tempDir);
    expect(result).toBe(configPath);
  });

  it("finds routermcp.json file", async () => {
    const configPath = join(tempDir, "routermcp.json");
    await writeFile(configPath, '{"mcpServers":{}}');

    const result = await findConfigFile(tempDir);
    expect(result).toBe(configPath);
  });

  it("prefers routermcp.jsonc over routermcp.json", async () => {
    const jsoncPath = join(tempDir, "routermcp.jsonc");
    const jsonPath = join(tempDir, "routermcp.json");
    await writeFile(jsoncPath, '{"mcpServers":{}}');
    await writeFile(jsonPath, '{"mcpServers":{}}');

    const result = await findConfigFile(tempDir);
    expect(result).toBe(jsoncPath);
  });

  it("returns null when no config file exists", async () => {
    const result = await findConfigFile(tempDir);
    expect(result).toBeNull();
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("basic loading", () => {
    it("loads valid stdio config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["hello"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test).toEqual({
        transport: "stdio",
        command: "echo",
        args: ["hello"],
        enabled: true,
      });
    });

    it("loads valid http-streamable config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "http://localhost:3000/mcp",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test).toEqual({
        transport: "http-streamable",
        url: "http://localhost:3000/mcp",
        enabled: true,
      });
    });

    it("throws on non-existent file", async () => {
      const configPath = join(tempDir, "nonexistent.jsonc");

      await expect(loadConfig(configPath)).rejects.toThrow("Config file not found");
    });
  });

  describe("JSONC parsing", () => {
    it("parses config with comments", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        `{
					// This is a comment
					"mcpServers": {
						/* Multi-line
						   comment */
						"test": {
							"transport": "stdio",
							"command": "echo"
						}
					}
				}`,
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.command).toBe("echo");
    });

    it("parses config with trailing commas", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        `{
					"mcpServers": {
						"test": {
							"transport": "stdio",
							"command": "echo",
							"args": ["hello",],
						},
					},
				}`,
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["hello"]);
    });

    it("throws on invalid JSON syntax", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(configPath, "{ invalid json }");

      await expect(loadConfig(configPath)).rejects.toThrow();
    });
  });

  describe("normalization", () => {
    it("maps 'type' to 'transport' for Claude Code compatibility", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              type: "stdio",
              command: "echo",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.transport).toBe("stdio");
    });

    it("maps 'http' to 'http-streamable'", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http",
              url: "http://localhost:3000",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.transport).toBe("http-streamable");
    });

    it("auto-detects stdio from 'command' key", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              command: "echo",
              args: ["hello"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.transport).toBe("stdio");
    });

    it("auto-detects http-streamable from 'url' key", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: "http://localhost:3000/mcp",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.transport).toBe("http-streamable");
    });
  });

  describe("environment variable expansion", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("expands environment variables in strings", async () => {
      process.env.TEST_COMMAND = "custom-command";
      process.env.TEST_ARG = "custom-arg";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "${TEST_COMMAND}",
              args: ["${TEST_ARG}"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.command).toBe("custom-command");
      expect(config.mcpServers.test.args).toEqual(["custom-arg"]);
    });

    it("expands environment variables in URL", async () => {
      process.env.API_URL = "http://api.example.com/mcp";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "${API_URL}",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.url).toBe("http://api.example.com/mcp");
    });

    it("expands environment variables in headers", async () => {
      process.env.API_TOKEN = "secret-token";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "http://localhost:3000/mcp",
              headers: {
                Authorization: "Bearer ${API_TOKEN}",
              },
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.headers?.Authorization).toBe("Bearer secret-token");
    });

    it("expands environment variables in env field", async () => {
      process.env.EXTERNAL_KEY = "external-value";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              env: {
                INTERNAL_KEY: "${EXTERNAL_KEY}",
              },
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.env?.INTERNAL_KEY).toBe("external-value");
    });

    it("replaces undefined env vars with empty string (legacy)", async () => {
      process.env.UNDEFINED_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["${UNDEFINED_VAR}test"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["test"]);
    });
  });

  describe("environment variable expansion - new ${env:...} syntax", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("expands ${env:VAR} when variable is defined", async () => {
      process.env.MY_TOKEN = "secret123";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "http://localhost:3000/mcp",
              headers: { Authorization: "Bearer ${env:MY_TOKEN}" },
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.headers?.Authorization).toBe("Bearer secret123");
    });

    it("uses default value ${env:VAR:-default} when variable is missing", async () => {
      process.env.MISSING_PORT = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "http://localhost:${env:MISSING_PORT:-5151}/mcp",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.url).toBe("http://localhost:5151/mcp");
    });

    it("leaves ${env:VAR} unexpanded when missing without default", async () => {
      process.env.UNDEFINED_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["prefix${env:UNDEFINED_VAR}suffix"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["prefix${env:UNDEFINED_VAR}suffix"]);
    });

    it("allows empty string as explicit default ${env:VAR:-}", async () => {
      process.env.OPTIONAL_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["prefix${env:OPTIONAL_VAR:-}suffix"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["prefixsuffix"]);
    });

    it("handles multiple env vars in one string", async () => {
      process.env.HOST = "localhost";
      process.env.PORT = "8080";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "http://${env:HOST}:${env:PORT:-3000}/mcp",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.url).toBe("http://localhost:8080/mcp");
    });

    it("prefers env value over default when variable exists", async () => {
      process.env.MY_PORT = "9999";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "http://localhost:${env:MY_PORT:-3000}/mcp",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.url).toBe("http://localhost:9999/mcp");
    });

    it("trims whitespace in variable names", async () => {
      process.env.SPACED_VAR = "trimmed";

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "${ env:SPACED_VAR }",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.command).toBe("trimmed");
    });

    it("ignores invalid variable names and leaves them unexpanded", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["${env:123invalid}"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["${env:123invalid}"]);
    });

    it("supports default value with special characters", async () => {
      process.env.MISSING_URL = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "${env:MISSING_URL:-http://localhost:3000/path}",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.url).toBe("http://localhost:3000/path");
    });
  });

  describe("strict mode (strictEnvVars)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("throws ConfigError when strictEnvVars=true and ${env:VAR} is missing", async () => {
      process.env.REQUIRED_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          strictEnvVars: true,
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["${env:REQUIRED_VAR}"],
            },
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow(
        "Environment variable not found: REQUIRED_VAR",
      );
    });

    it("does not throw for ${env:VAR:-default} even in strict mode", async () => {
      process.env.OPTIONAL_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          strictEnvVars: true,
          mcpServers: {
            test: {
              transport: "stdio",
              command: "${env:OPTIONAL_VAR:-fallback}",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.command).toBe("fallback");
    });

    it("does not throw for legacy ${VAR} in strict mode (backward compat)", async () => {
      process.env.LEGACY_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          strictEnvVars: true,
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["${LEGACY_VAR}test"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["test"]);
    });

    it("works normally when strictEnvVars=false (default)", async () => {
      process.env.MISSING_VAR = undefined;

      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          strictEnvVars: false,
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              args: ["${env:MISSING_VAR}"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.args).toEqual(["${env:MISSING_VAR}"]);
    });
  });

  describe("validation", () => {
    it("throws on missing mcpServers", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(configPath, "{}");

      await expect(loadConfig(configPath)).rejects.toThrow(
        "At least one mcpServer or openApiServer must be configured",
      );
    });

    it("throws on empty mcpServers", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(configPath, '{"mcpServers":{}}');

      await expect(loadConfig(configPath)).rejects.toThrow(
        "At least one mcpServer or openApiServer must be configured",
      );
    });

    it("throws on missing command for stdio transport", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
            },
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it("throws on invalid URL for http-streamable transport", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "http-streamable",
              url: "not-a-valid-url",
            },
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it("validates port range for httpServer", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { transport: "stdio", command: "echo" },
          },
          httpServer: {
            port: 99999, // Invalid port
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it("validates session timeout range", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { transport: "stdio", command: "echo" },
          },
          session: {
            timeout: 0, // Invalid: minimum is 1
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow();
    });
  });

  describe("filtering config", () => {
    it("loads tool filtering config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              allowedTools: ["tool1", "tool2"],
              denyTools: ["dangerous"],
              allowedToolsGlob: ["read_*"],
              denyToolsGlob: ["delete_*"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.allowedTools).toEqual(["tool1", "tool2"]);
      expect(config.mcpServers.test.denyTools).toEqual(["dangerous"]);
      expect(config.mcpServers.test.allowedToolsGlob).toEqual(["read_*"]);
      expect(config.mcpServers.test.denyToolsGlob).toEqual(["delete_*"]);
    });

    it("loads resource filtering config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              allowedResources: ["file:///safe"],
              denyResources: ["file:///secret"],
              allowedResourcesGlob: ["file:///public/*"],
              denyResourcesGlob: ["**/private/**"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.allowedResources).toEqual(["file:///safe"]);
      expect(config.mcpServers.test.denyResources).toEqual(["file:///secret"]);
      expect(config.mcpServers.test.allowedResourcesGlob).toEqual(["file:///public/*"]);
      expect(config.mcpServers.test.denyResourcesGlob).toEqual(["**/private/**"]);
    });

    it("loads prompt filtering config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              transport: "stdio",
              command: "echo",
              allowedPrompts: ["safe_prompt"],
              denyPrompts: ["admin_prompt"],
              allowedPromptsGlob: ["public_*"],
              denyPromptsGlob: ["*_secret"],
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test.allowedPrompts).toEqual(["safe_prompt"]);
      expect(config.mcpServers.test.denyPrompts).toEqual(["admin_prompt"]);
      expect(config.mcpServers.test.allowedPromptsGlob).toEqual(["public_*"]);
      expect(config.mcpServers.test.denyPromptsGlob).toEqual(["*_secret"]);
    });
  });

  describe("optional configs", () => {
    it("applies default values for session config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { transport: "stdio", command: "echo" },
          },
          session: {},
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.session?.timeout).toBe(300);
      expect(config.session?.max_sessions).toBe(25);
    });

    it("applies default values for codeMode config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { transport: "stdio", command: "echo" },
          },
          codeMode: {},
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.codeMode?.enabled).toBe(false);
      expect(config.codeMode?.timeout).toBe(30000);
      expect(config.codeMode?.allowFetch).toBe(true);
    });

    it("loads httpServer config", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { transport: "stdio", command: "echo" },
          },
          httpServer: {
            port: 8080,
            host: "0.0.0.0",
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.httpServer?.port).toBe(8080);
      expect(config.httpServer?.host).toBe("0.0.0.0");
    });
  });

  describe("multiple servers", () => {
    it("loads multiple server configs", async () => {
      const configPath = join(tempDir, "routermcp.jsonc");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            server1: {
              transport: "stdio",
              command: "cmd1",
            },
            server2: {
              transport: "http-streamable",
              url: "http://localhost:3000/mcp",
            },
            server3: {
              transport: "stdio",
              command: "cmd3",
              enabled: false,
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(Object.keys(config.mcpServers)).toHaveLength(3);
      expect(config.mcpServers.server1.transport).toBe("stdio");
      expect(config.mcpServers.server2.transport).toBe("http-streamable");
      expect(config.mcpServers.server3.enabled).toBe(false);
    });
  });
});

describe("loadConfigFromPath", () => {
  let tempDir: string;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await cleanupTempDir(tempDir);
  });

  it("loads config from explicit path", async () => {
    const configPath = join(tempDir, "custom-config.jsonc");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { transport: "stdio", command: "echo" },
        },
      }),
    );

    const { config, path } = await loadConfigFromPath(configPath);
    expect(path).toBe(configPath);
    expect(config.mcpServers.test.command).toBe("echo");
  });

  it("searches in cwd when no path specified", async () => {
    const configPath = join(tempDir, "routermcp.jsonc");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { transport: "stdio", command: "echo" },
        },
      }),
    );

    // Mock process.cwd to return tempDir
    process.cwd = () => tempDir;

    const { config, path } = await loadConfigFromPath();
    expect(path).toBe(configPath);
    expect(config.mcpServers.test.command).toBe("echo");
  });

  it("throws when no config found in cwd", async () => {
    process.cwd = () => tempDir;

    await expect(loadConfigFromPath()).rejects.toThrow("No config file found");
  });
});

describe("project config identity migration", () => {
  let homeDir: string;
  let projectDir: string;

  beforeEach(async () => {
    homeDir = await createTempDir();
    projectDir = join(homeDir, "workspace", "foo", "bar");
    await mkdir(projectDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTempDir(homeDir);
  });

  it("finds an existing XDG user-project config under its legacy ID", async () => {
    const legacyId = getLegacyProjectId(projectDir);
    const legacyConfigPath = join(
      homeDir,
      ".config",
      "routermcp",
      "projects",
      legacyId,
      "routermcp.jsonc",
    );
    await mkdir(join(homeDir, ".config", "routermcp", "projects", legacyId), {
      recursive: true,
    });
    await writeFile(legacyConfigPath, '{"mcpServers":{}}');

    const locations = await getConfigLocations(projectDir);

    expect(locations[1]).toEqual({
      scope: "user-project",
      path: legacyConfigPath,
      exists: true,
    });
    await expect(resolveConfigPathForScope("user-project", projectDir)).resolves.toBe(
      legacyConfigPath,
    );
  });

  it("prefers the new project ID when both config locations exist", async () => {
    const legacyId = getLegacyProjectId(projectDir);
    const newId = getProjectId(projectDir);
    const legacyConfigPath = join(
      homeDir,
      ".config",
      "routermcp",
      "projects",
      legacyId,
      "routermcp.jsonc",
    );
    const newConfigPath = getUserProjectConfigPath(newId);

    await mkdir(join(homeDir, ".config", "routermcp", "projects", legacyId), {
      recursive: true,
    });
    await mkdir(join(homeDir, ".config", "routermcp", "projects", newId), {
      recursive: true,
    });
    await writeFile(legacyConfigPath, '{"mcpServers":{}}');
    await writeFile(newConfigPath, '{"mcpServers":{}}');

    const locations = await getConfigLocations(projectDir);

    expect(locations[1]).toEqual({
      scope: "user-project",
      path: newConfigPath,
      exists: true,
    });
    await expect(resolveConfigPathForScope("user-project", projectDir)).resolves.toBe(
      newConfigPath,
    );
  });
});
