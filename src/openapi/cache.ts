import crypto from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRouterMcpDir } from "../daemon/project.js";
import type { CacheMetadata, OpenApiTool } from "./types.js";

const CACHE_VERSION = "1.0.0";
const DEFAULT_TTL_SECONDS = 86400; // 24 hours

export function getOpenApiCacheDir(): string {
  return resolve(getRouterMcpDir(), "openapi-cache");
}

export function getServerCacheDir(serverName: string): string {
  return resolve(getOpenApiCacheDir(), serverName);
}

export async function clearAllCache(verbose = false): Promise<void> {
  const cacheDir = getOpenApiCacheDir();
  try {
    await rm(cacheDir, { recursive: true, force: true });
    if (verbose) {
      console.error(`[openapi] Cleared cache directory: ${cacheDir}`);
    }
  } catch {
    // Directory might not exist
  }
}

export async function clearServerCache(serverName: string): Promise<void> {
  const serverDir = getServerCacheDir(serverName);
  try {
    await rm(serverDir, { recursive: true, force: true });
  } catch {
    // Directory might not exist
  }
}

export async function isCacheValid(
  serverName: string,
  specSource: string | Record<string, unknown>,
): Promise<boolean> {
  const cacheDir = getServerCacheDir(serverName);
  const metadataPath = resolve(cacheDir, "metadata.json");

  try {
    await stat(metadataPath);
    const content = await readFile(metadataPath, "utf-8");
    const metadata: CacheMetadata = JSON.parse(content);

    if (metadata.version !== CACHE_VERSION) {
      return false;
    }

    const now = new Date();
    const expiresAt = new Date(metadata.expiresAt);
    if (now >= expiresAt) {
      return false;
    }

    const currentHash = hashSpec(specSource);
    if (metadata.sourceHash !== currentHash) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function loadFromCache(serverName: string): Promise<OpenApiTool[]> {
  const cacheDir = getServerCacheDir(serverName);
  const toolsPath = resolve(cacheDir, "tools.json");

  const content = await readFile(toolsPath, "utf-8");
  const tools: OpenApiTool[] = JSON.parse(content);

  return tools;
}

export async function saveToCache(
  serverName: string,
  specSource: string | Record<string, unknown>,
  tools: OpenApiTool[],
  verbose = false,
): Promise<void> {
  const cacheDir = getServerCacheDir(serverName);

  await mkdir(cacheDir, { recursive: true });

  const toolsPath = resolve(cacheDir, "tools.json");
  await writeFile(toolsPath, JSON.stringify(tools, null, 2));

  const now = new Date();
  const sourceUrl =
    typeof specSource === "string" && specSource.startsWith("http") ? specSource : undefined;

  const metadata: CacheMetadata = {
    sourceHash: hashSpec(specSource),
    sourceUrl,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_SECONDS * 1000).toISOString(),
    ttlSeconds: DEFAULT_TTL_SECONDS,
    toolCount: tools.length,
    version: CACHE_VERSION,
  };

  const metadataPath = resolve(cacheDir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  if (verbose) {
    console.error(`[openapi] Cached ${tools.length} tools for ${serverName}`);
  }
}

function hashSpec(spec: string | Record<string, unknown>): string {
  const content = typeof spec === "string" ? spec : JSON.stringify(spec);
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}
