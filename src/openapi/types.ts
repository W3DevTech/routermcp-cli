import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenApiServerConfig, OpenApiAuthConfig } from "../config/types.js";

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
  error?: Error;
}
