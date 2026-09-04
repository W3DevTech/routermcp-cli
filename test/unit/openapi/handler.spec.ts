import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/openapi/cache.js", () => ({
  clearAllCache: vi.fn(),
  isCacheValid: vi.fn().mockResolvedValue(false),
  loadFromCache: vi.fn(),
  saveToCache: vi.fn().mockResolvedValue(undefined),
}));

import { OpenApiHandler } from "../../../src/openapi/handler.js";

const spec = {
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: { "200": { description: "A list of pets" } },
      },
    },
  },
};

describe("OpenApiHandler management snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports pending, ready, and failed OpenAPI servers without auth details", async () => {
    const handler = new OpenApiHandler({
      pets: {
        spec,
        auth: { type: "bearer", token: "do-not-expose" },
      },
      broken: {
        spec: {
          openapi: "3.0.0",
          info: { title: "Broken", version: "1.0.0" },
          paths: {},
        },
      },
    });

    expect(handler.getSnapshots()).toEqual([
      { name: "pets", status: "pending", toolCount: 0 },
      { name: "broken", status: "pending", toolCount: 0 },
    ]);

    await handler.initialize();

    const snapshots = handler.getSnapshots();
    expect(snapshots[0]).toMatchObject({
      name: "pets",
      status: "ready",
      baseUrl: "https://api.example.com/v1",
      toolCount: 1,
      lastCheckedAt: expect.any(Number),
      lastLatencyMs: expect.any(Number),
    });
    expect(snapshots[0]).not.toHaveProperty("auth");
    expect(snapshots[1]).toMatchObject({
      name: "broken",
      status: "error",
      toolCount: 0,
      lastError: "No baseUrl configured and none found in OpenAPI spec",
      lastCheckedAt: expect.any(Number),
      lastLatencyMs: expect.any(Number),
    });
  });

  it("uses the configured base URL for cached tools", async () => {
    const { isCacheValid, loadFromCache } = await import("../../../src/openapi/cache.js");
    vi.mocked(isCacheValid).mockResolvedValue(true);
    vi.mocked(loadFromCache).mockResolvedValue([
      {
        tool: {
          name: "pets_listPets",
          description: "List pets",
          inputSchema: { type: "object" },
        },
        execution: {
          serverName: "pets",
          method: "GET",
          pathTemplate: "/pets",
          baseUrl: "https://cached.example.com",
          parameters: [],
        },
      },
    ]);

    const handler = new OpenApiHandler({
      pets: {
        spec,
        baseUrl: "https://configured.example.com",
      },
    });

    await handler.initialize();

    expect(handler.getSnapshots()).toEqual([
      expect.objectContaining({
        name: "pets",
        status: "ready",
        baseUrl: "https://configured.example.com",
        toolCount: 1,
      }),
    ]);
  });
});
