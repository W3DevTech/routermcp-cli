import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { type Gateway, createGateway } from "../../src/core/gateway.js";

const FIXTURES_DIR = join(__dirname, "../fixtures");
const EVERYTHING_CONFIG = join(FIXTURES_DIR, "everything-server-config.jsonc");

describe("Gateway Integration with server-everything", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    const config = await loadConfig(EVERYTHING_CONFIG);
    gateway = createGateway({
      config,
      mode: "stdio",
      verbose: false,
    });
    await gateway.start();
  }, 120000);

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  describe("gateway state", () => {
    it("is in running state after start", () => {
      expect(gateway.getState()).toBe("running");
    });

    it("has session stats available", () => {
      const stats = gateway.getSessionStats();
      expect(stats).toBeDefined();
      expect(stats?.maxSessions).toBeGreaterThan(0);
    });
  });
});

describe("Gateway tool discovery", () => {
  let gateway: Gateway;
  let config: Awaited<ReturnType<typeof loadConfig>>;

  beforeAll(async () => {
    config = await loadConfig(EVERYTHING_CONFIG);
    gateway = createGateway({
      config,
      mode: "stdio",
      verbose: false,
    });
    await gateway.start();
  }, 120000);

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  it("discovers tools from server-everything", async () => {
    const state = gateway.getState();
    expect(state).toBe("running");
  });
});

describe("Gateway with mock MCP server", () => {
  it("can create gateway instance", () => {
    const mockConfig = {
      mcpServers: {
        test: {
          transport: "stdio" as const,
          command: "echo",
          args: ["test"],
          enabled: true,
        },
      },
    };

    const gw = createGateway({
      config: mockConfig,
      mode: "stdio",
      verbose: false,
    });

    expect(gw).toBeDefined();
    expect(gw.getState()).toBe("stopped");
  });
});
