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
import {
  CONTROL_PLANE_DEFAULT_EVENT_LIMIT,
  CONTROL_PLANE_HEALTH_PATH,
  CONTROL_PLANE_MAX_EVENT_LIMIT,
  CONTROL_PLANE_PATH,
  sanitizeText,
  type ControlPlane,
} from "../control-plane/index.js";
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

export const DAEMON_HEALTH_PATH = CONTROL_PLANE_HEALTH_PATH;
/** Kept for clients built against the pre-control-plane daemon prototype. */
export const DAEMON_HEALTH_PATH_LEGACY = "/__routermcp/health";
/** Narrow lifecycle API used by the stdio bridge; not the management API. */
export const DAEMON_BRIDGE_LEASES_PATH = "/api/v1/bridge-leases";
/** Default hosted management origin for a token-protected local daemon. */
export const DEFAULT_DAEMON_CORS_ORIGIN = "https://cli.routermcp.com";
/**
 * Exact browser origins used by the hosted console in production and by the
 * RouterMCP Next.js app during local development. Keep this list finite: the
 * authenticated daemon must never reflect arbitrary origins or use `*`.
 */
export const DEFAULT_DAEMON_CORS_ORIGINS = [
  DEFAULT_DAEMON_CORS_ORIGIN,
  "http://localhost:7953",
  "http://127.0.0.1:7953",
] as const;

export interface BridgeLeaseTracker {
  acquire: () => ConnectionLease;
  heartbeat: (leaseId: string) => ConnectionLease | null;
  release: (leaseId: string) => void;
  readonly leases?: readonly ConnectionLease[];
}

export interface HttpServerOptions {
  /**
   * Bearer token for the daemon control surface. A connection tracker makes
   * the bridge-lease routes part of that control surface, so those routes
   * require this token even when the standalone MCP endpoint is anonymous.
   */
  authToken?: string;
  health?: () => Record<string, unknown>;
  /** Management API state for a managed loopback daemon. */
  controlPlane?: ControlPlane;
  connectionTracker?: BridgeLeaseTracker;
  /** Called after a successful MCP initialize response for one HTTP session. */
  onSessionInitialize?: (
    sessionId: string,
    clientInfo?: { name: string; version?: string },
  ) => Promise<void> | void;
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
  clientRequestId: string | number;
}

class BunHttpServerTransport implements SessionAwareTransport {
  sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * The JSON-RPC request id is scoped to an MCP session. A shared daemon can
   * therefore receive the same id from multiple clients at once. Replace the
   * client id with an internal id before dispatching to the SDK so responses
   * cannot overwrite or resolve another client's pending request.
   */
  private pendingRequests = new Map<string, PendingRequest>();
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
      const pending = this.pendingRequests.get(message.id.toString());
      if (pending) {
        clearTimeout(pending.timeout);
        const response = { ...message, id: pending.clientRequestId } as JSONRPCMessage;
        pending.resolve(response);
        this.pendingRequests.delete(message.id.toString());
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
    // The MCP SDK reads `transport.sessionId` synchronously while dispatching
    // a request and captures it in the request handler's `extra` object. Keep
    // that value aligned with the HTTP session instead of leaving the random
    // constructor ID shared by every browser/client connection.
    this.sessionId = sessionId;

    if (
      "method" in message &&
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      const clientRequestId = message.id;
      const internalRequestId = randomUUID();
      const internalMessage = { ...message, id: internalRequestId } as JSONRPCMessage;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(internalRequestId);
          reject(new Error("Request timeout"));
        }, this.requestTimeout);

        this.pendingRequests.set(internalRequestId, {
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
          clientRequestId,
        });

        try {
          this.onmessage?.(internalMessage);
        } catch (error) {
          clearTimeout(timeout);
          this.pendingRequests.delete(internalRequestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
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
                      "Cache-Control": "no-store",
                      ...corsHeaders(request),
                    },
                  },
                );
              }

              const controlRoute = parseControlPlanePath(url);
              if (controlRoute) {
                if (request.method === "OPTIONS") {
                  return new Response(null, { status: 204, headers: corsHeaders(request) });
                }

                if (!options.controlPlane) {
                  return new Response("Not Found", { status: 404, headers: corsHeaders(request) });
                }

                if (!isAuthorized(request, options.authToken)) {
                  return new Response("Unauthorized", {
                    status: 401,
                    headers: corsHeaders(request),
                  });
                }

                return handleControlPlaneRequest(request, controlRoute, options.controlPlane, corsHeaders);
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
                const requestStartedAt = performance.now();
                let requestMethod: string | undefined;
                try {
                  const sessionId = request.headers.get("mcp-session-id") || randomUUID();
                  const body = (await request.json()) as JSONRPCMessage;
                  requestMethod = getJsonRpcMethod(body);

                  const response = await transport.handleRequestWithSession(body, sessionId);

                  const protocolError = isJsonRpcProtocolError(response);
                  const resultError = isJsonRpcResultError(response);

                  if (requestMethod === "initialize" && response && !protocolError) {
                    await options.onSessionInitialize?.(sessionId, getInitializeClientInfo(body));
                  }

                  options.controlPlane?.recordRequest({
                    durationMs: performance.now() - requestStartedAt,
                    method: requestMethod,
                    error: protocolError,
                    resultError,
                  });
                  options.controlPlane?.recordEvent({
                    level: protocolError || resultError ? "warn" : "debug",
                    type: "mcp.request",
                    message: `${requestMethod ?? "request"} completed`,
                    metadata: {
                      ...(requestMethod ? { method: requestMethod } : {}),
                      latencyMs: Math.round(performance.now() - requestStartedAt),
                    },
                  });

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
                  options.controlPlane?.recordRequest({
                    durationMs: performance.now() - requestStartedAt,
                    method: requestMethod,
                    error: true,
                  });
                  options.controlPlane?.recordEvent({
                    level: "error",
                    type: "mcp.error",
                    message: `${requestMethod ?? "request"} failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                    metadata: {
                      ...(requestMethod ? { method: requestMethod } : {}),
                      latencyMs: Math.round(performance.now() - requestStartedAt),
                    },
                  });
                  const message = sanitizeControlError(err);
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

type ControlPlaneRoute =
  | { kind: "status" }
  | { kind: "servers" }
  | { kind: "sessions" }
  | { kind: "metrics" }
  | { kind: "events"; limit: number }
  | { kind: "restart" }
  | { kind: "invalid"; message: string };

function parseControlPlanePath(url: URL): ControlPlaneRoute | null {
  switch (url.pathname) {
    case `${CONTROL_PLANE_PATH}/status`:
      return url.search
        ? { kind: "invalid", message: "The status endpoint does not accept query parameters" }
        : { kind: "status" };
    case `${CONTROL_PLANE_PATH}/servers`:
      return url.search
        ? { kind: "invalid", message: "The servers endpoint does not accept query parameters" }
        : { kind: "servers" };
    case `${CONTROL_PLANE_PATH}/sessions`:
      return url.search
        ? { kind: "invalid", message: "The sessions endpoint does not accept query parameters" }
        : { kind: "sessions" };
    case `${CONTROL_PLANE_PATH}/metrics`:
      return url.search
        ? { kind: "invalid", message: "The metrics endpoint does not accept query parameters" }
        : { kind: "metrics" };
    case `${CONTROL_PLANE_PATH}/restart`:
      return url.search
        ? { kind: "invalid", message: "The restart endpoint does not accept query parameters" }
        : { kind: "restart" };
    case `${CONTROL_PLANE_PATH}/events`: {
      const rawLimit = url.searchParams.get("limit");
      if (url.searchParams.size > (rawLimit === null ? 0 : 1)) {
        return { kind: "invalid", message: "Only the limit query parameter is supported" };
      }
      if (rawLimit === null) {
        return { kind: "events", limit: CONTROL_PLANE_DEFAULT_EVENT_LIMIT };
      }
      if (!/^\d+$/.test(rawLimit)) {
        return { kind: "invalid", message: "The limit query parameter must be a positive integer" };
      }
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed)) {
        return { kind: "invalid", message: "The limit query parameter is too large" };
      }
      return {
        kind: "events",
        limit: Math.min(Math.max(parsed, 1), CONTROL_PLANE_MAX_EVENT_LIMIT),
      };
    }
    default:
      return null;
  }
}

async function handleControlPlaneRequest(
  request: Request,
  route: ControlPlaneRoute,
  controlPlane: ControlPlane,
  headers: (request: Request) => Record<string, string>,
): Promise<Response> {
  const responseHeaders = headers(request);

  if (route.kind === "invalid") {
    return jsonResponse(
      { error: "Invalid request", message: route.message },
      400,
      responseHeaders,
    );
  }

  if (route.kind === "restart") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }

    try {
      const result = await controlPlane.restart();
      return jsonResponse(result, result.accepted ? 202 : 409, responseHeaders);
    } catch (error) {
      return jsonResponse(
        {
          error: "Restart failed",
          message: sanitizeControlError(error),
        },
        500,
        responseHeaders,
      );
    }
  }

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
  }

  switch (route.kind) {
    case "status":
      return jsonResponse({ status: controlPlane.getStatus() }, 200, responseHeaders);
    case "servers":
      return jsonResponse({ servers: controlPlane.getServers() }, 200, responseHeaders);
    case "sessions":
      return jsonResponse({ sessions: controlPlane.getSessions() }, 200, responseHeaders);
    case "metrics":
      return jsonResponse({ metrics: controlPlane.getMetrics() }, 200, responseHeaders);
    case "events":
      return jsonResponse({ events: controlPlane.getEvents(route.limit) }, 200, responseHeaders);
  }
}

function sanitizeControlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message);
}

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

function getJsonRpcMethod(message: JSONRPCMessage): string | undefined {
  if (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    typeof message.method === "string"
  ) {
    return message.method;
  }
  return undefined;
}

function getInitializeClientInfo(
  message: JSONRPCMessage,
): { name: string; version?: string } | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("method" in message) ||
    message.method !== "initialize" ||
    !("params" in message) ||
    typeof message.params !== "object" ||
    message.params === null ||
    !("clientInfo" in message.params) ||
    typeof message.params.clientInfo !== "object" ||
    message.params.clientInfo === null ||
    !("name" in message.params.clientInfo) ||
    typeof message.params.clientInfo.name !== "string" ||
    message.params.clientInfo.name.length === 0
  ) {
    return undefined;
  }

  const version =
    "version" in message.params.clientInfo &&
    typeof message.params.clientInfo.version === "string" &&
    message.params.clientInfo.version.length > 0
      ? message.params.clientInfo.version
      : undefined;

  return {
    name: message.params.clientInfo.name,
    ...(version ? { version } : {}),
  };
}

function isJsonRpcProtocolError(message: JSONRPCMessage | null): boolean {
  return typeof message === "object" && message !== null && "error" in message;
}

function isJsonRpcResultError(message: JSONRPCMessage | null): boolean {
  if (typeof message !== "object" || message === null || !("result" in message)) {
    return false;
  }

  const result = message.result;
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
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
  value: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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
      origins: new Set(DEFAULT_DAEMON_CORS_ORIGINS.map(normalizeOrigin)),
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
