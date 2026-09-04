import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Compute a SHA-256 digest for an already-loaded configuration value.
 *
 * Configuration objects are normalized recursively before hashing so that
 * object-key ordering does not cause a profile to appear changed. Arrays keep
 * their order because it is meaningful to command arguments and other config
 * lists.
 */
export function fingerprintConfig(config: unknown): string {
  return sha256(stableSerialize(config));
}

/**
 * Compute a SHA-256 digest of the bytes on disk for a config file.
 *
 * Hashing the source bytes intentionally includes JSONC comments and
 * whitespace. This lets the lifecycle layer detect that the file changed and
 * keeps the operation independent of the config parser's normalization.
 */
export async function fingerprintConfigFile(configPath: string): Promise<string> {
  const content = await readFile(resolve(configPath));
  return sha256(content);
}

/**
 * Return the canonical absolute path used when deriving profile identity.
 */
export function normalizeConfigPath(configPath: string): string {
  return resolve(configPath);
}

/**
 * Exposed for callers that need to fingerprint arbitrary profile inputs.
 */
export function fingerprintString(value: string): string {
  return sha256(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      // JSON.stringify omits undefined object properties. Omitting them here
      // keeps the canonical representation aligned with JSON semantics.
      if (item !== undefined) {
        sorted[key] = canonicalize(item);
      }
    }
    return sorted;
  }

  return value;
}
