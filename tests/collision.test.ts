/**
 * Tests for collision detection
 */

import { describe, test, expect } from "bun:test";
import { detectCollisions, checkCollisions } from "../src/filtering/collision.js";
import { CollisionError } from "../src/utils/errors.js";

describe("detectCollisions", () => {
  test("returns no collisions for unique names", () => {
    const items = new Map([
      ["server1", ["tool1", "tool2"]],
      ["server2", ["tool3", "tool4"]],
    ]);
    const result = detectCollisions(items);
    expect(result.hasCollisions).toBe(false);
    expect(result.collisions.size).toBe(0);
  });

  test("detects collisions across servers", () => {
    const items = new Map([
      ["server1", ["tool1", "tool2"]],
      ["server2", ["tool2", "tool3"]],
    ]);
    const result = detectCollisions(items);
    expect(result.hasCollisions).toBe(true);
    expect(result.collisions.get("tool2")).toEqual(["server1", "server2"]);
  });

  test("detects multiple collisions", () => {
    const items = new Map([
      ["server1", ["tool1", "tool2"]],
      ["server2", ["tool1", "tool2"]],
      ["server3", ["tool1", "tool3"]],
    ]);
    const result = detectCollisions(items);
    expect(result.hasCollisions).toBe(true);
    expect(result.collisions.size).toBe(2);
    expect(result.collisions.get("tool1")).toEqual(["server1", "server2", "server3"]);
    expect(result.collisions.get("tool2")).toEqual(["server1", "server2"]);
  });

  test("handles empty input", () => {
    const items = new Map<string, string[]>();
    const result = detectCollisions(items);
    expect(result.hasCollisions).toBe(false);
    expect(result.collisions.size).toBe(0);
  });
});

describe("checkCollisions", () => {
  test("does not throw for no collisions", () => {
    const items = new Map([
      ["server1", ["tool1"]],
      ["server2", ["tool2"]],
    ]);
    expect(() => checkCollisions(items, "tool")).not.toThrow();
  });

  test("throws CollisionError for collisions", () => {
    const items = new Map([
      ["server1", ["tool1"]],
      ["server2", ["tool1"]],
    ]);
    expect(() => checkCollisions(items, "tool")).toThrow(CollisionError);
  });
});
