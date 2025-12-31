import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { Gateway, createGateway } from "../../src/core/gateway.js";
import { loadConfig } from "../../src/config/loader.js";

const FIXTURES_DIR = join(__dirname, "../fixtures");
const MULTI_SERVER_CONFIG = join(FIXTURES_DIR, "multi-server-everything-config.jsonc");

describe("Multi-server filtering integration", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    const config = await loadConfig(MULTI_SERVER_CONFIG);
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

  it("starts gateway with multiple filtered servers", () => {
    expect(gateway.getState()).toBe("running");
  });

  it("has session stats available for multi-server setup", () => {
    const stats = gateway.getSessionStats();
    expect(stats).toBeDefined();
    expect(stats?.maxSessions).toBeGreaterThan(0);
  });
});

describe("Collision detection", () => {
  it("throws error when tools collide without filtering", async () => {
    const collisionConfig = join(FIXTURES_DIR, "collision-config.jsonc");
    const config = await loadConfig(collisionConfig);

    const gateway = createGateway({
      config,
      mode: "stdio",
      verbose: false,
    });

    await expect(gateway.start()).rejects.toThrow();

    try {
      await gateway.stop();
    } catch {
    }
  }, 120000);
});

describe("Filtering prevents collisions", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    const config = await loadConfig(MULTI_SERVER_CONFIG);
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

  it("starts successfully with filtered servers that would otherwise collide", () => {
    expect(gateway.getState()).toBe("running");
  });
});
