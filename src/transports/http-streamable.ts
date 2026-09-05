import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionLease } from "../daemon/connection-tracker.js";
import { type ServerHandle, serve } from "../compat/index.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";

export interface HttpClientTransportOptions {
  authProvider?: OAuthClientProvider;
}

export async function createHttpClientTransport(
  serverName: string,
  config: ServerConfig,
  options?: HttpClientTransportOptions,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  if (config.transport !== "http-streamable") {
    throw new TransportError(
      "http-streamable",
      `Expected http-streamable transport, got ${config.transport}`,
    );
  }

  if (!config.url) {
    throw new TransportError("http-streamable", "URL is required for http-streamable transport");
  }

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.headers,
    },
    authProvider: options?.authProvider,
  });

  const client = new Client(
    {
      name: `routermcp-client-${serverName}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await client.connect(transport);

  const cleanup = async () => {
    try {
      await client.close();
    } catch {}
  };

  return { client, cleanup };
}

export interface HttpServerHandle {
  transport: SessionAwareTransport;
  server: ServerHandle | null;
  getPort: () => number | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export const DAEMON_HEALTH_PATH = "/api/v1/health";
/** Kept for clients built against the pre-control-plane daemon prototype. */
export const DAEMON_HEALTH_PATH_LEGACY = "/__routermcp/health";
/** Narrow lifecycle API used by the stdio bridge; not the management API. */
export const DAEMON_BRIDGE_LEASES_PATH = "/api/v1/bridge-leases";
/** Default hosted management origin for a token-protected local daemon. */
export const DEFAULT_DAEMON_CORS_ORIGIN = "https://cli.routermcp.com";

export interface BridgeLeaseTracker {
  acquire: () => ConnectionLease;
  heartbeat: (leaseId: string) => ConnectionLease | null;
  release: (leaseId: string) => void;
}

export interface HttpServerOptions {
  /**
   * Bearer token for the daemon control surface. A connection tracker makes
   * the bridge-lease routes part of that control surface, so those routes
   * require this token even when the standalone MCP endpoint is anonymous.
   */
  authToken?: string;
  health?: () => Record<string, unknown>;
  connectionTracker?: BridgeLeaseTracker;
  onSessionClose?: (sessionId: string) => Promise<void> | void;
  /** Exact browser origins allowed to call this HTTP server. */
  corsOrigins?: readonly string[];
}

export interface SessionAwareTransport extends Transport {
  getCurrentSessionId(): string | null;
  handleRequestWithSession(
    message: JSONRPCMessage,
    sessionId: string,
  ): Promise<JSONRPCMessage | null>;
}

interface PendingRequest {
  resolve: (response: JSONRPCMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  sessionId: string;
}

class BunHttpServerTransport implements SessionAwareTransport {
  sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private pendingRequests = new Map<string | number, PendingRequest>();
  private started = false;
  private readonly requestTimeout = 30000;
  private currentSessionId: string | null = null;

  constructor() {
    this.sessionId = randomUUID();
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ("id" in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(message);
        this.pendingRequests.delete(message.id);
      }
    }
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Transport closed"));
    }
    this.pendingRequests.clear();
    this.onclose?.();
  }

  handleRequestWithSession(
    message: JSONRPCMessage,
    sessionId: string,
  ): Promise<JSONRPCMessage | null> {
    if (!this.started) {
      return Promise.reject(new Error("Transport not started"));
    }

    this.currentSessionId = sessionId;

    if ("method" in message && "id" in message && message.id !== undefined) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(message.id!);
          reject(new Error("Request timeout"));
        }, this.requestTimeout);

        this.pendingRequests.set(message.id!, {
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          timeout,
          sessionId,
        });

        this.onmessage?.(message);
      });
    }

    this.onmessage?.(message);
    return Promise.resolve(null);
  }
}

export function createHttpServerTransport(
  port: number,
  host = "127.0.0.1",
  options: HttpServerOptions = {},
): HttpServerHandle {
  const transport = new BunHttpServerTransport();
  let server: ServerHandle | null = null;
  let boundPort: number | null = null;

  const corsPolicy = createCorsPolicy(options);

  const corsHeaders = (request: Request): Record<string, string> => ({
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    ...corsPolicyHeaders(request, corsPolicy),
  });

  const handle: HttpServerHandle = {
    transport,
    server: null,
    getPort: () => boundPort,

    start: async () => {
      let candidatePort = port;
      let lastError: unknown;

      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          server = serve({
            port: candidatePort,
            host,
            fetch: async (request: Request) => {
              const url = new URL(request.url);

              if (
                url.pathname === DAEMON_HEALTH_PATH ||
                url.pathname === DAEMON_HEALTH_PATH_LEGACY
              ) {
                if (request.method === "OPTIONS") {
                  return new Response(null, { status: 204, headers: corsHeaders(request) });
                }

                if (request.method !== "GET") {
                  return new Response("Method Not Allowed", {
                    status: 405,
                    headers: corsHeaders(request),
                  });
                }

                if (!isAuthorized(request, options.authToken)) {
                  return new Response("Unauthorized", {
                    status: 401,
                    headers: corsHeaders(request),
                  });
                }

                return new Response(
                  JSON.stringify({
                    ok: true,
                    ...(options.health ? options.health() : {}),
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders(request),
                      ...(options.authToken ? {} : { "Cache-Control": "no-store" }),
                    },
                  },
                );
              }

              const leaseRoute = parseBridgeLeasePath(url.pathname);
              if (leaseRoute) {
                if (request.method === "OPTIONS") {
                  return new Response(null, { status: 204, headers: corsHeaders(request) });
                }

                if (!options.connectionTracker) {
                  return new Response("Not Found", { status: 404, headers: corsHeaders(request) });
                }

                // Lease state controls the daemon's lifecycle and must never
                // be exposed by an anonymous standalone HTTP transport. Keep
                // the MCP endpoint backwards-compatible when no auth token is
                // configured, but fail closed for every lease mutation.
                if (!isAuthorized(request, options.authToken, true)) {
                  return new Response("Unauthorized", {
                    status: 401,
                    headers: corsHeaders(request),
                  });
                }

                if (leaseRoute.kind === "acquire" && request.method === "POST") {
                  return jsonResponse(options.connectionTracker.acquire(), 201, corsHeaders(request));
                }

                if (leaseRoute.kind === "heartbeat" && request.method === "POST") {
                  const lease = options.connectionTracker.heartbeat(leaseRoute.leaseId);
                  return lease
                    ? jsonResponse(lease, 200, corsHeaders(request))
                    : new Response("Lease Not Found", {
                        status: 404,
                        headers: corsHeaders(request),
                      });
                }

                if (leaseRoute.kind === "release" && request.method === "DELETE") {
                  options.connectionTracker.release(leaseRoute.leaseId);
                  return new Response(null, { status: 204, headers: corsHeaders(request) });
                }

                return new Response("Method Not Allowed", {
                  status: 405,
                  headers: corsHeaders(request),
                });
              }

              if (url.pathname !== "/mcp") {
                return new Response("Not Found", { status: 404 });
              }

              if (request.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: corsHeaders(request) });
              }

              if (!isAuthorized(request, options.authToken)) {
                return new Response("Unauthorized", {
                  status: 401,
                  headers: corsHeaders(request),
                });
              }

              if (request.method === "POST") {
                try {
                  const sessionId = request.headers.get("mcp-session-id") || randomUUID();
                  const body = (await request.json()) as JSONRPCMessage;

                  const response = await transport.handleRequestWithSession(body, sessionId);

                  if (response) {
                    return new Response(JSON.stringify(response), {
                      status: 200,
                      headers: {
                        "Content-Type": "application/json",
                        "Mcp-Session-Id": sessionId,
                        ...corsHeaders(request),
                      },
                    });
                  }

                  return new Response(null, {
                    status: 202,
                    headers: {
                      "Mcp-Session-Id": sessionId,
                      ...corsHeaders(request),
                    },
                  });
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  return new Response(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      error: { code: -32603, message },
                      id: null,
                    }),
                    {
                      status: 500,
                      headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders(request),
                      },
                    },
                  );
                }
              }

              if (request.method === "DELETE") {
                const sessionId = request.headers.get("mcp-session-id");
                if (!sessionId) {
                  return new Response("Mcp-Session-Id is required", {
                    status: 400,
                    headers: corsHeaders(request),
                  });
                }

                await options.onSessionClose?.(sessionId);
                return new Response(null, { status: 204, headers: corsHeaders(request) });
              }

              return new Response("Method Not Allowed", {
                status: 405,
                headers: corsHeaders(request),
              });
            },
          });

          if (server.ready) {
            boundPort = await server.ready;
          } else {
            boundPort = server.port;
          }
          handle.server = server;
          await transport.start();
          console.error(`HTTP MCP server listening on http://${host}:${boundPort}/mcp`);
          return;
        } catch (error) {
          lastError = error;
          server?.stop();
          server = null;
          handle.server = null;
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EADDRINUSE") {
            throw error;
          }
          candidatePort++;
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error(`Unable to bind HTTP server near port ${port}`);
    },

    stop: async () => {
      if (server) {
        server.stop();
        server = null;
        handle.server = null;
      }
      boundPort = null;
      await transport.close();
    },
  };

  return handle;
}

type BridgeLeaseRoute =
  | { kind: "acquire" }
  | { kind: "heartbeat" | "release"; leaseId: string };

function parseBridgeLeasePath(pathname: string): BridgeLeaseRoute | null {
  if (pathname === DAEMON_BRIDGE_LEASES_PATH) {
    return { kind: "acquire" };
  }

  const prefix = `${DAEMON_BRIDGE_LEASES_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;

  const suffix = pathname.slice(prefix.length);
  const parts = suffix.split("/");
  if (parts.length === 1 && parts[0]) {
    return { kind: "release", leaseId: decodePathPart(parts[0]) };
  }
  if (parts.length === 2 && parts[1] === "heartbeat" && parts[0]) {
    return { kind: "heartbeat", leaseId: decodePathPart(parts[0]) };
  }
  return null;
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAuthorized(
  request: Request,
  authToken: string | undefined,
  requireToken = false,
): boolean {
  if (!authToken) return !requireToken;
  return request.headers.get("authorization") === `Bearer ${authToken}`;
}

function jsonResponse(
  value: ConnectionLease,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}

interface CorsPolicy {
  wildcard: boolean;
  origins: Set<string>;
}

function createCorsPolicy(options: HttpServerOptions): CorsPolicy {
  if (options.corsOrigins) {
    return {
      wildcard: false,
      origins: new Set(options.corsOrigins.map(normalizeOrigin).filter(Boolean)),
    };
  }

  // A daemon bearer token protects a local service that may be called from the
  // hosted management UI. Never pair that token with wildcard browser access.
  if (options.authToken) {
    return {
      wildcard: false,
      origins: new Set([DEFAULT_DAEMON_CORS_ORIGIN]),
    };
  }

  // Preserve the standalone HTTP transport's backwards-compatible behavior.
  return { wildcard: true, origins: new Set() };
}

function corsPolicyHeaders(request: Request, policy: CorsPolicy): Record<string, string> {
  const requestedOrigin = request.headers.get("origin");
  const normalizedRequestedOrigin = requestedOrigin ? normalizeOrigin(requestedOrigin) : "";
  const allowed = policy.wildcard
    ? "*"
    : normalizedRequestedOrigin && policy.origins.has(normalizedRequestedOrigin)
      ? normalizedRequestedOrigin
      : undefined;

  const headers: Record<string, string> = {};
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
  }

  if (!policy.wildcard) {
    headers.Vary = "Origin, Access-Control-Request-Private-Network";
  }

  if (
    allowed &&
    allowed !== "*" &&
    request.headers.get("access-control-request-private-network")?.toLowerCase() === "true"
  ) {
    headers["Access-Control-Allow-Private-Network"] = "true";
  }

  return headers;
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim();
  }
}
