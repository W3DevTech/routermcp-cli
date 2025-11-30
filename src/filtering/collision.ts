/**
 * Name collision detection for aggregated capabilities
 */

import { CollisionError } from "../utils/errors.js";

/**
 * Result of collision detection
 */
export interface CollisionResult {
  hasCollisions: boolean;
  collisions: Map<string, string[]>;
}

/**
 * Detects name collisions across multiple sources
 *
 * @param items Map of server name to array of item names
 * @returns CollisionResult with collision details
 */
export function detectCollisions(
  items: Map<string, string[]>,
): CollisionResult {
  const nameToSources = new Map<string, string[]>();

  // Build map of name -> sources
  for (const [source, names] of items) {
    for (const name of names) {
      const sources = nameToSources.get(name) ?? [];
      sources.push(source);
      nameToSources.set(name, sources);
    }
  }

  // Find collisions (names with more than one source)
  const collisions = new Map<string, string[]>();
  for (const [name, sources] of nameToSources) {
    if (sources.length > 1) {
      collisions.set(name, sources);
    }
  }

  return {
    hasCollisions: collisions.size > 0,
    collisions,
  };
}

/**
 * Detects collisions and throws error if any found
 *
 * @param items Map of server name to array of item names
 * @param type The type of capability being checked
 * @throws CollisionError if collisions detected
 */
export function checkCollisions(
  items: Map<string, string[]>,
  type: "tool" | "resource" | "prompt",
): void {
  const result = detectCollisions(items);

  if (result.hasCollisions) {
    throw new CollisionError(result.collisions, type);
  }
}
