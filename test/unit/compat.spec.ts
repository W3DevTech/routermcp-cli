import { afterEach, describe, expect, it, vi } from "vitest";

describe("Bun HTTP compatibility", () => {
  const originalBun = globalThis.Bun;

  afterEach(() => {
    vi.resetModules();
    if (originalBun === undefined) {
      Reflect.deleteProperty(globalThis, "Bun");
    } else {
      Object.defineProperty(globalThis, "Bun", {
        configurable: true,
        value: originalBun,
      });
    }
  });

  it("keeps the Bun server stop method callable through the compatibility handle", async () => {
    const stop = vi.fn(function stop(this: unknown) {
      expect(this).toBe(server);
    });
    const server = {
      port: 9123,
      stop,
    };

    Object.defineProperty(globalThis, "Bun", {
      configurable: true,
      value: {
        serve: vi.fn(() => server),
      },
    });

    vi.resetModules();
    const { serve } = await import("../../src/compat/index.js");
    const handle = serve({ port: 7858, fetch: () => new Response(null) });

    expect(handle.port).toBe(9123);
    await expect(handle.ready).resolves.toBe(9123);
    handle.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
