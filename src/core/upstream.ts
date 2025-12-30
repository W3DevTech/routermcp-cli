import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, RouterMcpConfig } from "../config/types.js";
import { createClientTransport, type ClientConnection } from "../transports/index.js";
import { UpstreamError } from "../utils/errors.js";

export interface ServerCapabilityCache {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export type UpstreamStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "disabled"
  | "discovered";

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
  cachedTools: Tool[];
  cachedResources: Resource[];
  cachedPrompts: Prompt[];
  lastActivity: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  connectionPromise: Promise<Client> | null;
}

export class UpstreamManager {
  private servers: Map<string, UpstreamServer> = new Map();
  private verbose: boolean;
  private subprocessTimeout: number;
  private connectionTimeout: number;

  constructor(
    config: RouterMcpConfig,
    verbose: boolean = false,
    preloadedCapabilities?: Map<string, ServerCapabilityCache>
  ) {
    this.verbose = verbose;
    this.subprocessTimeout = config.subprocess_timeout ?? 180;
    this.connectionTimeout = config.connection_timeout ?? 30;

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const enabled = serverConfig.enabled !== false;
      const cached = preloadedCapabilities?.get(name);

      this.servers.set(name, {
        name,
        config: serverConfig,
        status: enabled ? (cached ? "discovered" : "disconnected") : "disabled",
        client: null,
        cleanup: null,
        error: null,
        tools: cached?.tools ?? [],
        resources: cached?.resources ?? [],
        prompts: cached?.prompts ?? [],
        cachedTools: cached?.tools ?? [],
        cachedResources: cached?.resources ?? [],
        cachedPrompts: cached?.prompts ?? [],
        lastActivity: null,
        idleTimer: null,
        connectionPromise: null,
      });
    }
  }

  async discoverAll(concurrency: number = 5): Promise<void> {
    const servers = Array.from(this.servers.values()).filter(
      (s) => s.status !== "disabled"
    );

    this.log(
      `Discovering capabilities from ${servers.length} servers (concurrency: ${concurrency})`
    );

    for (let i = 0; i < servers.length; i += concurrency) {
      const batch = servers.slice(i, i + concurrency);
      const batchNum = Math.floor(i / concurrency) + 1;
      const totalBatches = Math.ceil(servers.length / concurrency);

      this.log(
        `Processing batch ${batchNum}/${totalBatches}: ${batch.map((s) => s.name).join(", ")}`
      );

      await Promise.allSettled(batch.map((server) => this.discoverOne(server.name)));
    }

    const discovered = this.getDiscoveredOrConnected().length;
    this.log(`Discovery complete: ${discovered}/${servers.length} servers available`);
  }

  async discoverOne(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) {
      throw new UpstreamError(name, "Server not found in configuration");
    }

    if (server.status === "disabled") {
      this.log(`Skipping disabled server: ${name}`);
      return;
    }

    try {
      await this.connectOneWithTimeout(name);
      await this.fetchCapabilities(server);

      server.cachedTools = [...server.tools];
      server.cachedResources = [...server.resources];
      server.cachedPrompts = [...server.prompts];

      this.log(
        `Discovered ${name}: ${server.cachedTools.length} tools, ` +
          `${server.cachedResources.length} resources, ${server.cachedPrompts.length} prompts`
      );

      await this.disconnectOne(name);
      server.status = "discovered";
    } catch (err) {
      server.status = "error";
      server.error = err instanceof Error ? err : new Error(String(err));
      console.error(`Failed to discover ${name}: ${server.error.message}`);
    }
  }

  private async connectOneWithTimeout(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) {
      throw new UpstreamError(name, "Server not found in configuration");
    }

    server.status = "connecting";
    this.log(`Connecting to ${name}...`);

    const timeoutMs = this.connectionTimeout * 1000;

    const connectionPromise = createClientTransport(name, server.config);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.connectionTimeout}s`));
      }, timeoutMs);
    });

    try {
      const connection = await Promise.race([connectionPromise, timeoutPromise]);
      server.client = connection.client;
      server.cleanup = connection.cleanup;
      server.status = "connected";
      server.error = null;
    } catch (err) {
      server.status = "error";
      server.error = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }

  async ensureConnected(name: string): Promise<Client> {
    const server = this.servers.get(name);
    if (!server) {
      throw new UpstreamError(name, "Server not found");
    }

    if (server.status === "disabled") {
      throw new UpstreamError(name, "Server is disabled");
    }

    if (server.status === "connected" && server.client) {
      this.resetIdleTimer(server);
      return server.client;
    }

    if (server.status === "connecting" && server.connectionPromise) {
      this.log(`Waiting for existing connection to ${name}...`);
      return server.connectionPromise;
    }

    server.connectionPromise = this.doConnect(name);

    try {
      const client = await server.connectionPromise;
      return client;
    } finally {
      server.connectionPromise = null;
    }
  }

  private async doConnect(name: string): Promise<Client> {
    const server = this.servers.get(name)!;

    await this.connectOneWithTimeout(name);

    if (!server.client) {
      throw new UpstreamError(name, "Connection failed");
    }

    if (server.cachedTools.length > 0) {
      server.tools = server.cachedTools;
      server.resources = server.cachedResources;
      server.prompts = server.cachedPrompts;
    }

    this.resetIdleTimer(server);

    this.log(`Connected to ${name} (on-demand)`);
    return server.client;
  }

  private resetIdleTimer(server: UpstreamServer): void {
    if (server.idleTimer) {
      clearTimeout(server.idleTimer);
      server.idleTimer = null;
    }

    server.lastActivity = Date.now();

    if (this.subprocessTimeout > 0) {
      server.idleTimer = setTimeout(async () => {
        this.log(
          `Idle timeout (${this.subprocessTimeout}s) reached for ${server.name}, disconnecting...`
        );
        await this.disconnectOne(server.name);
        server.status = "discovered";
      }, this.subprocessTimeout * 1000);
    }
  }

  async disconnectOne(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;

    if (server.idleTimer) {
      clearTimeout(server.idleTimer);
      server.idleTimer = null;
    }

    server.connectionPromise = null;

    if (server.cleanup) {
      try {
        await server.cleanup();
      } catch (err) {
        console.error(`Error disconnecting from ${name}: ${err}`);
      }
    }

    server.client = null;
    server.cleanup = null;
    server.lastActivity = null;
  }

  private async fetchCapabilities(server: UpstreamServer): Promise<void> {
    if (!server.client) return;

    try {
      const toolsResult = await server.client.listTools();
      server.tools = toolsResult.tools || [];
    } catch (err) {
      this.log(`Failed to fetch tools from ${server.name}: ${err}`);
      server.tools = [];
    }

    try {
      const resourcesResult = await server.client.listResources();
      server.resources = resourcesResult.resources || [];
    } catch (err) {
      this.log(`Failed to fetch resources from ${server.name}: ${err}`);
      server.resources = [];
    }

    try {
      const promptsResult = await server.client.listPrompts();
      server.prompts = promptsResult.prompts || [];
    } catch (err) {
      this.log(`Failed to fetch prompts from ${server.name}: ${err}`);
      server.prompts = [];
    }
  }

  async disconnectAll(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    for (const server of this.servers.values()) {
      if (server.idleTimer) {
        clearTimeout(server.idleTimer);
        server.idleTimer = null;
      }

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
      server.connectionPromise = null;
      server.lastActivity = null;
      server.status = server.config.enabled !== false ? "disconnected" : "disabled";
    }
  }

  getAll(): UpstreamServer[] {
    return Array.from(this.servers.values());
  }

  getConnected(): UpstreamServer[] {
    return this.getAll().filter((s) => s.status === "connected");
  }

  getDiscoveredOrConnected(): UpstreamServer[] {
    return this.getAll().filter(
      (s) => s.status === "connected" || s.status === "discovered"
    );
  }

  get(name: string): UpstreamServer | undefined {
    return this.servers.get(name);
  }

  getClient(name: string): Client | null {
    return this.servers.get(name)?.client ?? null;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[upstream] ${message}`);
    }
  }
}
