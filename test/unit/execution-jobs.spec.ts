import { describe, expect, it, vi } from "vitest";
import {
  ExecutionJobManager,
  ExecutionJobQueueFullError,
} from "../../src/core/execution-jobs.js";

describe("ExecutionJobManager", () => {
  it("enforces per-workspace concurrency and preserves terminal state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new ExecutionJobManager({ maxConcurrencyPerWorkspace: 1, maxQueuedPerWorkspace: 1 });
    const first = manager.submit("workspace", "tool-call", async () => {
      await gate;
      return { ok: true };
    });
    const second = manager.submit("workspace", "tool-call", async () => ({ second: true }));

    expect(manager.get("workspace", first.id)).toMatchObject({ state: "running" });
    expect(manager.get("workspace", second.id)).toMatchObject({ state: "queued" });
    release();
    await vi.waitFor(() => expect(manager.get("workspace", first.id)).toMatchObject({ state: "succeeded" }));
    await vi.waitFor(() => expect(manager.get("workspace", second.id)).toMatchObject({ state: "succeeded" }));
  });

  it("cancels queued work and bounds oversized output", async () => {
    const manager = new ExecutionJobManager({ maxConcurrencyPerWorkspace: 1, outputMaxBytes: 32 });
    const gate = new Promise<void>(() => undefined);
    manager.submit("workspace", "tool-call", async () => gate);
    const queued = manager.submit("workspace", "tool-call", async () => "never");
    expect(manager.cancel("workspace", queued.id)).toMatchObject({ state: "cancelled" });

    const output = manager.submit("other", "tool-call", async () => "x".repeat(100));
    await vi.waitFor(() => expect(manager.get("other", output.id)).toMatchObject({ state: "failed", error: { code: "output-too-large" } }));
  });

  it("rejects work beyond the queue bound", () => {
    const manager = new ExecutionJobManager({ maxConcurrencyPerWorkspace: 1, maxQueuedPerWorkspace: 1 });
    const gate = new Promise<void>(() => undefined);
    manager.submit("workspace", "tool-call", async () => gate);
    manager.submit("workspace", "tool-call", async () => gate);
    expect(() => manager.submit("workspace", "tool-call", async () => gate)).toThrow(ExecutionJobQueueFullError);
  });
});
