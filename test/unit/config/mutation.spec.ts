import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigMutationError,
  ConfigRevisionConflictError,
  createExecutionModeSnapshot,
  getExecutionMode,
  parseConfigServerId,
  parseExecutionModePatch,
  readConfigSnapshot,
  setExecutionMode,
  setServerEnabled,
} from "../../../src/config/mutation.js";
import {
  cleanupTempDir,
  createTempDir,
  writeConfigFile,
} from "../../helpers/test-utils.js";

describe("JSONC management mutations", () => {
  it("preserves comments/trailing commas and atomically toggles a prefixed server", async () => {
    const directory = await createTempDir();
    try {
      const configPath = join(directory, "routermcp.jsonc");
      await writeFile(
        configPath,
        `{
  // Keep this comment when the dashboard changes availability.
  "mcpServers": {
    "demo": {
      "transport": "stdio",
      "command": "true",
    },
  },
}
`,
      );
      await chmod(configPath, 0o640);

      const before = await readConfigSnapshot(configPath);
      const result = await setServerEnabled({
        configPath,
        expectedDigest: before.digest,
        serverId: "mcp:demo",
        enabled: false,
      });

      expect(result.changed).toBe(true);
      expect(result.previousEnabled).toBe(true);
      expect(result.config.mcpServers.demo.enabled).toBe(false);
      expect((await readConfigSnapshot(configPath)).digest).toBe(result.configDigest);

      const source = await readFile(configPath, "utf8");
      expect(source).toContain("Keep this comment");
      expect(source).toContain('"enabled": false');
      expect(source).toContain(",\n  },\n}");
      expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("rejects stale revisions and serializes same-process writers", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: {
          first: { transport: "stdio", command: "true" },
          second: { transport: "stdio", command: "true" },
        },
      });
      const before = await readConfigSnapshot(configPath);

      const first = setServerEnabled({
        configPath,
        expectedDigest: before.digest,
        serverId: "mcp:first",
        enabled: false,
      });
      const second = setServerEnabled({
        configPath,
        expectedDigest: before.digest,
        serverId: "mcp:second",
        enabled: false,
      });
      await expect(first).resolves.toMatchObject({ changed: true });
      await expect(second).rejects.toBeInstanceOf(ConfigRevisionConflictError);

      const current = await readConfigSnapshot(configPath);
      await expect(
        setServerEnabled({
          configPath,
          expectedDigest: current.digest,
          serverId: "demo",
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: "invalid-request", status: 400 });
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("supports OpenAPI IDs without allowing mcp/openapi name collisions", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { shared: { transport: "stdio", command: "true" } },
        openApiServers: {
          shared: { spec: "https://example.com/openapi.json", enabled: true },
        },
      });
      const before = await readConfigSnapshot(configPath);
      const result = await setServerEnabled({
        configPath,
        expectedDigest: before.digest,
        serverId: "openapi:shared",
        enabled: false,
      });

      expect(result.config.mcpServers.shared.enabled).toBe(true);
      expect(result.config.openApiServers?.shared.enabled).toBe(false);
      expect(parseConfigServerId("mcp:shared")).toEqual({ kind: "mcp", name: "shared" });
      expect(parseConfigServerId("openapi:shared")).toEqual({
        kind: "openapi",
        name: "shared",
      });
    } finally {
      await cleanupTempDir(directory);
    }
  });

  it("enforces mutually exclusive execution modes and Code Mode bounds", async () => {
    const directory = await createTempDir();
    try {
      const configPath = await writeConfigFile(directory, {
        mcpServers: { demo: { transport: "stdio", command: "true" } },
      });
      const standard = await readConfigSnapshot(configPath);
      const code = await setExecutionMode({
        configPath,
        expectedDigest: standard.digest,
        patch: { mode: "code", codeMode: { timeout: 15_000, allowFetch: false } },
      });
      expect(getExecutionMode(code.config)).toBe("code");
      expect(code.config.codeMode).toMatchObject({ enabled: true, timeout: 15_000, allowFetch: false });
      expect(code.config.mcpToolSearch?.enabled).toBe(false);
      expect(createExecutionModeSnapshot({ ...code, path: configPath })).toMatchObject({
        mode: "code",
        codeMode: { timeout: 15_000, allowFetch: false },
      });

      const search = await setExecutionMode({
        configPath,
        expectedDigest: code.configDigest,
        patch: { mode: "tool-search" },
      });
      expect(getExecutionMode(search.config)).toBe("tool-search");
      expect(search.config.codeMode?.enabled).toBe(false);
      expect(search.config.mcpToolSearch?.enabled).toBe(true);

      await expect(
        setExecutionMode({
          configPath,
          expectedDigest: search.configDigest,
          patch: { mode: "code", codeMode: { timeout: 999 } },
        }),
      ).rejects.toMatchObject({ code: "invalid-request", status: 400 });
      expect(() => parseExecutionModePatch({ mode: "code", codeMode: { allowFetch: "yes" } })).toThrow(
        ConfigMutationError,
      );
      expect(() => parseExecutionModePatch({ mode: "standard", codeMode: {} })).toThrow(
        /only be changed when mode is code/,
      );
    } finally {
      await cleanupTempDir(directory);
    }
  });
});
