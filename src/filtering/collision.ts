import { createHash } from "node:crypto";
import { CollisionError } from "../utils/errors.js";

function fourHexId(name: string, serverName: string): string {
  return createHash("sha256").update(`${name}\0${serverName}`).digest("hex").slice(0, 4);
}

/**
 * Item with source server information.
 */
export interface ItemWithSource {
  name: string;
  serverName: string;
}

/**
 * Collision information.
 */
export interface Collision {
  name: string;
  type: "tool" | "resource" | "prompt";
  servers: string[];
}

/**
 * Detect name collisions in a list of items from multiple servers.
 * Returns null if no collisions, or a CollisionError if collisions exist.
 */
export function detectCollisions(
  items: ItemWithSource[],
  type: "tool" | "resource" | "prompt",
): CollisionError | null {
  const nameToServers = new Map<string, string[]>();

  for (const item of items) {
    const servers = nameToServers.get(item.name) || [];
    servers.push(item.serverName);
    nameToServers.set(item.name, servers);
  }

  const collisions: Collision[] = [];

  for (const [name, servers] of nameToServers) {
    if (servers.length > 1) {
      collisions.push({ name, type, servers });
    }
  }

  if (collisions.length > 0) {
    return new CollisionError(collisions);
  }

  return null;
}

export function disambiguateNames(items: ItemWithSource[]): string[] {
  const nameToServers = new Map<string, string[]>();
  for (const item of items) {
    const servers = nameToServers.get(item.name) ?? [];
    if (!servers.includes(item.serverName)) servers.push(item.serverName);
    nameToServers.set(item.name, servers);
  }
  const nameToIndex = new Map<string, number>();
  const result: string[] = [];
  for (const item of items) {
    const servers = nameToServers.get(item.name);
    const count = servers ? servers.length : 0;
    if (count <= 1) {
      result.push(item.name);
      continue;
    }
    const idx = nameToIndex.get(item.name) ?? 0;
    nameToIndex.set(item.name, idx + 1);
    result.push(idx === 0 ? item.name : `${item.name}_${fourHexId(item.name, item.serverName)}`);
  }
  return result;
}

/**
 * Check for collisions across tools, resources, and prompts.
 * Throws CollisionError if any collisions are found.
 */
export function checkAllCollisions(data: {
  tools: ItemWithSource[];
  resources: ItemWithSource[];
  prompts: ItemWithSource[];
}): void {
  const allCollisions: Collision[] = [];

  const toolCollision = detectCollisions(data.tools, "tool");
  if (toolCollision) {
    allCollisions.push(...toolCollision.collisions);
  }

  const resourceCollision = detectCollisions(data.resources, "resource");
  if (resourceCollision) {
    allCollisions.push(...resourceCollision.collisions);
  }

  const promptCollision = detectCollisions(data.prompts, "prompt");
  if (promptCollision) {
    allCollisions.push(...promptCollision.collisions);
  }

  if (allCollisions.length > 0) {
    throw new CollisionError(allCollisions);
  }
}
