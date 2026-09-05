import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenApiServerConfig } from "../config/types.js";
import { getToolFilter, shouldAllow } from "../filtering/filter.js";
import { clearAllCache, isCacheValid, loadFromCache, saveToCache } from "./cache.js";
import { convertSpecToTools } from "./converter.js";
import { executeHttpRequest } from "./executor.js";
import { extractBaseUrl, parseOpenApiSpec } from "./parser.js";
import type { OpenApiServerSnapshot, OpenApiServerState, OpenApiTool } from "./types.js";

export class OpenApiHandler {
  private servers: Map<string, OpenApiServerState> = new Map();
  private toolRegistry: Map<string, OpenApiTool> = new Map();
  private verbose: boolean;

  constructor(config: Record<string, OpenApiServerConfig> | undefined, verbose = false) {
    this.verbose = verbose;

    if (!config) return;

    for (const [name, serverConfig] of Object.entries(config)) {
      if (serverConfig.enabled === false) {
        this.log(`Skipping disabled OpenAPI server: ${name}`);
        continue;
      }

      this.servers.set(name, {
        name,
        config: serverConfig,
        status: "pending",
        tools: [],
        ...(serverConfig.baseUrl ? { baseUrl: serverConfig.baseUrl } : {}),
      });
    }
  }

  async initialize(clearCache = false): Promise<void> {
    if (this.servers.size === 0) {
      return;
    }

    this.log(`Initializing ${this.servers.size} OpenAPI server(s)...`);

    if (clearCache) {
      await clearAllCache(this.verbose);
    }

    const results = await Promise.allSettled(
      Array.from(this.servers.values()).map((server) => this.initializeServer(server)),
    );

    this.buildToolRegistry();

    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    this.log(`OpenAPI initialization complete: ${successful} succeeded, ${failed} failed`);
    this.log(`Total OpenAPI tools: ${this.toolRegistry.size}`);
  }

  private async initializeServer(server: OpenApiServerState): Promise<void> {
    server.status = "loading";
    const checkedAt = Date.now();
    const startedAt = performance.now();
    server.lastCheckedAt = checkedAt;

    try {
      const specSource = server.config.spec;

      if (await isCacheValid(server.name, specSource)) {
        this.log(`Loading ${server.name} from cache`);
        server.tools = await loadFromCache(server.name);
        server.baseUrl = server.config.baseUrl ?? server.tools[0]?.execution.baseUrl;
        server.status = "ready";
        return;
      }

      this.log(`Parsing OpenAPI spec for ${server.name}...`);
      const spec = await parseOpenApiSpec(specSource);

      const baseUrl = server.config.baseUrl || extractBaseUrl(spec) || "";

      if (!baseUrl) {
        throw new Error("No baseUrl configured and none found in OpenAPI spec");
      }

      const tools = convertSpecToTools(spec, server.name, baseUrl, server.config.auth);

      this.log(`Converted ${tools.length} tools from ${server.name}`);

      await saveToCache(server.name, specSource, tools, this.verbose);

      server.tools = tools;
      server.baseUrl = baseUrl;
      server.status = "ready";
    } catch (err) {
      server.status = "error";
      server.error = err instanceof Error ? err : new Error(String(err));

      console.error(
        `[openapi] Warning: Failed to initialize ${server.name}: ${server.error.message}`,
      );
    } finally {
      server.lastCheckedAt = checkedAt;
      server.lastLatencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    }
  }

  private buildToolRegistry(): void {
    this.toolRegistry.clear();

    for (const server of this.servers.values()) {
      if (server.status !== "ready") continue;

      const filter = getToolFilter(server.config);

      for (const openApiTool of server.tools) {
        const toolName = openApiTool.tool.name;

        if (!shouldAllow(toolName, filter)) {
          continue;
        }

        if (this.toolRegistry.has(toolName)) {
          console.error(`[openapi] Warning: Tool name collision: ${toolName}`);
          continue;
        }

        this.toolRegistry.set(toolName, openApiTool);
      }
    }
  }

  getTools(): Tool[] {
    return Array.from(this.toolRegistry.values()).map((t) => t.tool);
  }

  getToolsMap(): Map<string, { tool: Tool; serverName: string }> {
    const map = new Map<string, { tool: Tool; serverName: string }>();

    for (const [name, openApiTool] of this.toolRegistry) {
      map.set(name, {
        tool: openApiTool.tool,
        serverName: `openapi:${openApiTool.execution.serverName}`,
      });
    }

    return map;
  }

  hasTool(name: string): boolean {
    return this.toolRegistry.has(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const openApiTool = this.toolRegistry.get(name);

    if (!openApiTool) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await executeHttpRequest(openApiTool.execution, args);
      return result;
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  getStats(): {
    totalServers: number;
    readyServers: number;
    failedServers: number;
    totalTools: number;
  } {
    const servers = Array.from(this.servers.values());
    return {
      totalServers: servers.length,
      readyServers: servers.filter((s) => s.status === "ready").length,
      failedServers: servers.filter((s) => s.status === "error").length,
      totalTools: this.toolRegistry.size,
    };
  }

  /**
   * Return only the OpenAPI state needed by the local management API. Auth
   * configuration, generated tools, and spec contents stay inside the
   * handler and are never exposed as part of a server snapshot.
   */
  getSnapshots(): OpenApiServerSnapshot[] {
    return Array.from(this.servers.values(), (server) => ({
      name: server.name,
      status: server.status,
      ...(server.baseUrl ? { baseUrl: server.baseUrl } : {}),
      toolCount: server.tools.length,
      ...(server.lastCheckedAt !== undefined ? { lastCheckedAt: server.lastCheckedAt } : {}),
      ...(server.lastLatencyMs !== undefined ? { lastLatencyMs: server.lastLatencyMs } : {}),
      ...(server.error ? { lastError: server.error.message } : {}),
    }));
  }

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[openapi] ${message}`);
    }
  }
}
