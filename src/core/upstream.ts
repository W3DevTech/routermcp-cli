import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, RouterMcpConfig } from "../config/types.js";
import { createClientTransport, type ClientConnection } from "../transports/index.js";
import { UpstreamError } from "../utils/errors.js";

/**
 * Status of an upstream server connection.
 */
export type UpstreamStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "disabled";

/**
 * Upstream server connection.
 */
export interface UpstreamServer {
  name: string;
  config: ServerConfig;
  status: UpstreamStatus;
  client: Client | null;
  cleanup: (() => Promise<void>) | null;
  error: Error | null;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

/**
 * Manager for upstream MCP server connections.
 */
export class UpstreamManager {
  private servers: Map<string, UpstreamServer> = new Map();
  private verbose: boolean;

  constructor(config: RouterMcpConfig, verbose: boolean = false) {
    this.verbose = verbose;

    // Initialize server entries
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const enabled = serverConfig.enabled !== false;
      this.servers.set(name, {
        name,
        config: serverConfig,
        status: enabled ? "disconnected" : "disabled",
        client: null,
        cleanup: null,
        error: null,
        tools: [],
        resources: [],
        prompts: [],
      });
    }
  }

  /**
   * Connect to all enabled upstream servers.
   * Uses graceful degradation - continues even if some servers fail.
   */
  async connectAll(): Promise<void> {
    const connectPromises: Promise<void>[] = [];

    for (const server of this.servers.values()) {
      if (server.status === "disabled") {
        this.log(`Skipping disabled server: ${server.name}`);
        continue;
      }

      connectPromises.push(this.connectOne(server.name));
    }

    await Promise.allSettled(connectPromises);
  }

  /**
   * Connect to a single upstream server.
   */
  async connectOne(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) {
      throw new UpstreamError(name, "Server not found in configuration");
    }

    if (server.status === "disabled") {
      this.log(`Server ${name} is disabled`);
      return;
    }

    server.status = "connecting";
    this.log(`Connecting to ${name}...`);

    try {
      const connection = await createClientTransport(name, server.config);
      server.client = connection.client;
      server.cleanup = connection.cleanup;
      server.status = "connected";
      server.error = null;

      // Fetch capabilities
      await this.fetchCapabilities(server);

      this.log(
        `Connected to ${name}: ${server.tools.length} tools, ${server.resources.length} resources, ${server.prompts.length} prompts`
      );
    } catch (err) {
      server.status = "error";
      server.error = err instanceof Error ? err : new Error(String(err));
      console.error(`Failed to connect to ${name}: ${server.error.message}`);
    }
  }

  /**
   * Fetch tools, resources, and prompts from an upstream server.
   */
  private async fetchCapabilities(server: UpstreamServer): Promise<void> {
    if (!server.client) return;

    try {
      // Fetch tools
      const toolsResult = await server.client.listTools();
      server.tools = toolsResult.tools || [];
    } catch (err) {
      this.log(`Failed to fetch tools from ${server.name}: ${err}`);
      server.tools = [];
    }

    try {
      // Fetch resources
      const resourcesResult = await server.client.listResources();
      server.resources = resourcesResult.resources || [];
    } catch (err) {
      this.log(`Failed to fetch resources from ${server.name}: ${err}`);
      server.resources = [];
    }

    try {
      // Fetch prompts
      const promptsResult = await server.client.listPrompts();
      server.prompts = promptsResult.prompts || [];
    } catch (err) {
      this.log(`Failed to fetch prompts from ${server.name}: ${err}`);
      server.prompts = [];
    }
  }

  /**
   * Disconnect from all upstream servers.
   */
  async disconnectAll(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    for (const server of this.servers.values()) {
      if (server.cleanup) {
        cleanupPromises.push(
          server.cleanup().catch((err) => {
            console.error(`Error disconnecting from ${server.name}: ${err}`);
          })
        );
      }
    }

    await Promise.allSettled(cleanupPromises);

    for (const server of this.servers.values()) {
      server.client = null;
      server.cleanup = null;
      server.status = server.config.enabled !== false ? "disconnected" : "disabled";
    }
  }

  /**
   * Get all servers.
   */
  getAll(): UpstreamServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get connected servers only.
   */
  getConnected(): UpstreamServer[] {
    return this.getAll().filter((s) => s.status === "connected");
  }

  /**
   * Get a server by name.
   */
  get(name: string): UpstreamServer | undefined {
    return this.servers.get(name);
  }

  /**
   * Get the client for a server.
   */
  getClient(name: string): Client | null {
    return this.servers.get(name)?.client ?? null;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[upstream] ${message}`);
    }
  }
}
