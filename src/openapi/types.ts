import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenApiAuthConfig, OpenApiServerConfig } from "../config/types.js";

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface ParameterMeta {
  name: string;
  in: ParameterLocation;
  required: boolean;
}

export interface ToolExecutionMeta {
  serverName: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  baseUrl: string;
  parameters: ParameterMeta[];
  requestBodyContentType?: string;
  auth?: OpenApiAuthConfig;
}

export interface OpenApiTool {
  tool: Tool;
  execution: ToolExecutionMeta;
}

export interface CacheMetadata {
  sourceHash: string;
  sourceUrl?: string;
  generatedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  toolCount: number;
  version: string;
}

export type OpenApiServerStatus = "pending" | "loading" | "ready" | "error";

export interface OpenApiServerState {
  name: string;
  config: OpenApiServerConfig;
  status: OpenApiServerStatus;
  tools: OpenApiTool[];
  /** Resolved API base URL, retained for browser-safe management snapshots. */
  baseUrl?: string;
  error?: Error;
  lastCheckedAt?: number;
  lastLatencyMs?: number;
}

/** Provider-neutral OpenAPI state exposed to the local management plane. */
export interface OpenApiServerSnapshot {
  name: string;
  status: OpenApiServerStatus;
  baseUrl?: string;
  toolCount: number;
  lastCheckedAt?: number;
  lastLatencyMs?: number;
  lastError?: string;
}
