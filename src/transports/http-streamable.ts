import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { type ServerHandle, serve } from "../compat/index.js";
import type { ServerConfig } from "../config/types.js";
import {
  BrowserManagementError,
  type BrowserManagementSessionStore,
  CONTROL_PLANE_BROWSER_CHALLENGE_PATH,
  CONTROL_PLANE_BROWSER_DEVICES_PATH,
  CONTROL_PLANE_BROWSER_EXCHANGE_PATH,
  CONTROL_PLANE_DEFAULT_EVENT_LIMIT,
  CONTROL_PLANE_HEALTH_PATH,
  CONTROL_PLANE_MAX_EVENT_LIMIT,
  CONTROL_PLANE_PATH,
  ConfigMutationError,
  type ControlPlane,
  type ControlPlaneMutationResult,
  ControlPlaneWorkspaceNotFoundError,
  isValidWorkspaceId,
  MANAGEMENT_BODY_LIMIT_BYTES,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
  type ManagementCredentialStore,
  parseExecutionModePatch,
  parseManagementJsonBody,
  parseServerEnabledPatch,
  sanitizeText,
  WorkspaceMcpCredentialStore,
} from "../control-plane/index.js";
import { ExecutionJobQueueFullError } from "../core/execution-jobs.js";
import { ExecutionError } from "../core/execution-service.js";
import type { ConnectionLease } from "../daemon/connection-tracker.js";
import { TransportError } from "../utils/errors.js";

export {
  CONTROL_PLANE_BROWSER_CHALLENGE_PATH,
  CONTROL_PLANE_BROWSER_DEVICES_PATH,
  CONTROL_PLANE_BROWSER_EXCHANGE_PATH,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
} from "../control-plane/index.js";

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
/** Header used by the stdio bridge to bind MCP traffic to its lease. */
export const DAEMON_BRIDGE_LEASE_HEADER = "X-RouterMCP-Bridge-Lease-Id";
/** Header used by the stdio bridge to carry the canonical workspace ID. */
export const DAEMON_WORKSPACE_HEADER = "X-RouterMCP-Workspace-Id";
/** Create or explicitly rotate a durable workspace-scoped credential. */
export const WORKSPACE_MCP_CREDENTIAL_PATH = "/api/v1/management/mcp-credential";
/** Default hosted management origin for a token-protected local daemon. */
export const DEFAULT_DAEMON_CORS_ORIGIN = "https://cli.routermcp.com";

const DAEMON_INFO_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RouterMCP daemon</title>
</head>
<body>
  <main>
    <h1>RouterMCP daemon</h1>
    <p>The local RouterMCP gateway is running.</p>
    <p>Connect MCP clients to the workspace URL printed by <code>routermcp mcp-config</code> with its credential.</p>
    <p>Manage this daemon from <a href="https://cli.routermcp.com/cli">cli.routermcp.com</a> or an authenticated <code>/api/v1</code> request.</p>
  </main>
</body>
</html>`;

function daemonInfoResponse(request: Request, headers: Record<string, string>): Response {
  const responseHeaders = {
    ...headers,
    Allow: "GET, HEAD",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  return new Response(request.method === "HEAD" ? null : DAEMON_INFO_PAGE, {
    status: 200,
    headers: responseHeaders,
  });
}
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

class BridgeRequestContextError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401,
  ) {
    super(message);
    this.name = "BridgeRequestContextError";
  }
}

export interface BridgeLeaseTracker {
  acquire: (metadata?: unknown) => ConnectionLease | Promise<ConnectionLease>;
  heartbeat: (leaseId: string) => ConnectionLease | null | Promise<ConnectionLease | null>;
  release: (leaseId: string) => void | Promise<void>;
  readonly leases?: readonly ConnectionLease[];
}

/** Bounded wire metadata used to attribute a bridge to a local workspace. */
export interface BridgeLeaseMetadata {
  workspaceId?: string;
  directory: string;
  configPath: string;
  configScope: "project-local" | "user-project" | "user-global";
  configDigest: string;
  profileId?: string;
}

/** Authenticated request context used to attribute bridge traffic. */
export interface HttpRequestContext {
  workspaceId?: string;
  leaseId?: string;
}

/** Dispatch hook used by a host that owns one listener and many runtimes. */
export type HttpMcpRequestHandler = (
  message: JSONRPCMessage,
  sessionId: string,
  context?: HttpRequestContext,
) => Promise<JSONRPCMessage | null>;

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
  /** Short-lived browser credentials for the hosted management console. */
  managementCredentials?: ManagementCredentialStore;
  /** Separate scoped credentials for direct workspace MCP clients. */
  workspaceMcpCredentials?: ManagementCredentialStore | WorkspaceMcpCredentialStore;
  /** Public-key registry for remembered same-browser management sessions. */
  browserManagement?: BrowserManagementSessionStore;
  connectionTracker?: BridgeLeaseTracker;
  /** Route MCP requests into an embedded workspace runtime. */
  dispatchMcp?: HttpMcpRequestHandler;
  /** Called after a successful MCP initialize response for one HTTP session. */
  onSessionInitialize?: (
    sessionId: string,
    clientInfo?: { name: string; version?: string },
    context?: HttpRequestContext,
  ) => Promise<void> | void;
  onSessionClose?: (sessionId: string, context?: HttpRequestContext) => Promise<void> | void;
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
  const sessionContexts = new Map<string, HttpRequestContext>();

  const corsPolicy = createCorsPolicy(options);

  const corsHeaders = (request: Request): Record<string, string> => ({
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": `Authorization, Content-Type, If-Match, Mcp-Session-Id, ${DAEMON_BRIDGE_LEASE_HEADER}, ${DAEMON_WORKSPACE_HEADER}`,
    "Access-Control-Expose-Headers": `Mcp-Session-Id, ${DAEMON_BRIDGE_LEASE_HEADER}, ${DAEMON_WORKSPACE_HEADER}`,
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

              if (url.pathname === "/") {
                if (request.method === "OPTIONS") {
                  return new Response(null, { status: 204, headers: corsHeaders(request) });
                }
                if (request.method !== "GET" && request.method !== "HEAD") {
                  return new Response("Method Not Allowed", {
                    status: 405,
                    headers: { ...corsHeaders(request), Allow: "GET, HEAD" },
                  });
                }
                return daemonInfoResponse(request, corsHeaders(request));
              }

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
                      ...withWorkspaceAttribution(
                        corsHeaders(request),
                        options.controlPlane?.getCurrentWorkspaceId(),
                      ),
                    },
                  },
                );
              }

              const managementRoute = parseManagementCredentialPath(url);
              if (managementRoute) {
                if (request.method === "OPTIONS") {
                  return new Response(null, { status: 204, headers: corsHeaders(request) });
                }

                // Challenge and exchange intentionally do not carry a bearer
                // credential. The challenge is public loopback material; the
                // exchange is authenticated by an enrolled browser key.
                if (
                  (managementRoute.kind === "browser-challenge" ||
                    managementRoute.kind === "browser-exchange") &&
                  options.browserManagement
                ) {
                  return handleBrowserManagementRequest(
                    request,
                    managementRoute,
                    options.browserManagement,
                    options.managementCredentials,
                    corsHeaders,
                  );
                }

                if (managementRoute.kind === "workspace-mcp-credential") {
                  if (!options.workspaceMcpCredentials || !options.authToken) {
                    return new Response("Not Found", {
                      status: 404,
                      headers: corsHeaders(request),
                    });
                  }
                  if (!isLocalAuthorized(request, options.authToken)) {
                    return new Response("Unauthorized", {
                      status: 401,
                      headers: corsHeaders(request),
                    });
                  }
                  return handleWorkspaceMcpCredentialRequest(
                    request,
                    options.workspaceMcpCredentials,
                    corsHeaders,
                  );
                }

                // A handoff is a privileged local operation. Do not make it
                // available on an unauthenticated standalone HTTP server or
                // let an already-issued browser token mint more credentials.
                if (!options.managementCredentials || !options.authToken) {
                  return new Response("Not Found", { status: 404, headers: corsHeaders(request) });
                }

                if (
                  managementRoute.kind === "browser-devices" ||
                  managementRoute.kind === "browser-device"
                    ? !isBrowserManagementAuthorized(request, options)
                    : !isLocalAuthorized(request, options.authToken)
                ) {
                  return new Response("Unauthorized", {
                    status: 401,
                    headers: corsHeaders(request),
                  });
                }

                if (
                  managementRoute.kind === "browser-devices" ||
                  managementRoute.kind === "browser-device"
                ) {
                  return handleBrowserManagementRequest(
                    request,
                    managementRoute,
                    options.browserManagement,
                    options.managementCredentials,
                    corsHeaders,
                  );
                }

                return handleManagementCredentialRequest(
                  request,
                  managementRoute,
                  options.managementCredentials,
                  corsHeaders,
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

                if (!isControlPlaneAuthorized(request, options, controlRoute)) {
                  return new Response("Unauthorized", {
                    status: 401,
                    headers: corsHeaders(request),
                  });
                }

                return handleControlPlaneRequest(
                  request,
                  controlRoute,
                  options.controlPlane,
                  corsHeaders,
                  options,
                  sessionContexts,
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
                  let metadata: unknown;
                  try {
                    metadata = await readBridgeLeaseMetadata(request);
                  } catch (error) {
                    return jsonResponse(
                      {
                        error:
                          error instanceof RequestBodyLimitError
                            ? "Bridge lease metadata is too large"
                            : "Invalid bridge lease metadata",
                      },
                      error instanceof RequestBodyLimitError ? 413 : 400,
                      corsHeaders(request),
                    );
                  }

                  try {
                    const lease = await options.connectionTracker.acquire(metadata);
                    return jsonResponse(
                      lease,
                      201,
                      withLeaseAttribution(corsHeaders(request), lease),
                    );
                  } catch {
                    // Do not echo paths, config contents, or upstream details
                    // from a failed workspace registration to the bridge.
                    return jsonResponse(
                      { error: "Bridge workspace registration failed" },
                      400,
                      corsHeaders(request),
                    );
                  }
                }

                if (leaseRoute.kind === "heartbeat" && request.method === "POST") {
                  const lease = await options.connectionTracker.heartbeat(leaseRoute.leaseId);
                  return lease
                    ? jsonResponse(lease, 200, withLeaseAttribution(corsHeaders(request), lease))
                    : new Response("Lease Not Found", {
                        status: 404,
                        headers: corsHeaders(request),
                      });
                }

                if (leaseRoute.kind === "release" && request.method === "DELETE") {
                  const existingLease = options.connectionTracker.leases?.find(
                    (candidate) => candidate.leaseId === leaseRoute.leaseId,
                  );
                  await options.connectionTracker.release(leaseRoute.leaseId);
                  return new Response(null, {
                    status: 204,
                    headers: withLeaseAttribution(corsHeaders(request), {
                      leaseId: leaseRoute.leaseId,
                      workspaceId: existingLease?.workspaceId,
                    }),
                  });
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
                let requestContext: HttpRequestContext | undefined;
                try {
                  const sessionId = request.headers.get("mcp-session-id") || randomUUID();
                  requestContext = resolveRequestContext(
                    request,
                    sessionId,
                    options.connectionTracker,
                    sessionContexts,
                  );
                  const body = (await readBoundedJsonBody(
                    request,
                    MANAGEMENT_BODY_LIMIT_BYTES,
                    "MCP request",
                  )) as JSONRPCMessage;
                  requestMethod = getJsonRpcMethod(body);

                  const response = options.dispatchMcp
                    ? await options.dispatchMcp(body, sessionId, requestContext)
                    : await transport.handleRequestWithSession(body, sessionId);

                  const protocolError = isJsonRpcProtocolError(response);
                  const resultError = isJsonRpcResultError(response);

                  if (requestMethod === "initialize" && response && !protocolError) {
                    if (requestContext) sessionContexts.set(sessionId, requestContext);
                    await options.onSessionInitialize?.(
                      sessionId,
                      getInitializeClientInfo(body),
                      requestContext,
                    );
                  }

                  options.controlPlane?.recordRequest({
                    durationMs: performance.now() - requestStartedAt,
                    method: requestMethod,
                    error: protocolError,
                    resultError,
                    ...(requestContext?.workspaceId
                      ? { workspaceId: requestContext.workspaceId }
                      : {}),
                  });
                  options.controlPlane?.recordEvent({
                    level: protocolError || resultError ? "warn" : "debug",
                    type: "mcp.request",
                    message: `${requestMethod ?? "request"} completed`,
                    ...(requestContext?.workspaceId
                      ? { workspaceId: requestContext.workspaceId }
                      : {}),
                    metadata: {
                      ...(requestMethod ? { method: requestMethod } : {}),
                      ...requestContextMetadata(requestContext),
                      latencyMs: Math.round(performance.now() - requestStartedAt),
                    },
                  });

                  if (response) {
                    return new Response(JSON.stringify(response), {
                      status: 200,
                      headers: {
                        "Content-Type": "application/json",
                        "Mcp-Session-Id": sessionId,
                        ...withContextAttribution(corsHeaders(request), requestContext),
                      },
                    });
                  }

                  return new Response(null, {
                    status: 202,
                    headers: {
                      "Mcp-Session-Id": sessionId,
                      ...withContextAttribution(corsHeaders(request), requestContext),
                    },
                  });
                } catch (err) {
                  options.controlPlane?.recordRequest({
                    durationMs: performance.now() - requestStartedAt,
                    method: requestMethod,
                    error: true,
                    ...(requestContext?.workspaceId
                      ? { workspaceId: requestContext.workspaceId }
                      : {}),
                  });
                  options.controlPlane?.recordEvent({
                    level: "error",
                    type: "mcp.error",
                    message: `${requestMethod ?? "request"} failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                    ...(requestContext?.workspaceId
                      ? { workspaceId: requestContext.workspaceId }
                      : {}),
                    metadata: {
                      ...(requestMethod ? { method: requestMethod } : {}),
                      ...requestContextMetadata(requestContext),
                      latencyMs: Math.round(performance.now() - requestStartedAt),
                    },
                  });
                  const message = sanitizeControlError(err);
                  const status =
                    err instanceof RequestBodyLimitError
                      ? 413
                      : err instanceof BridgeRequestContextError
                        ? err.statusCode
                        : 500;
                  return new Response(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      error: {
                        code: status === 413 ? -32600 : -32603,
                        message:
                          status === 413
                            ? "MCP request body is too large"
                            : status === 401
                              ? "MCP bridge authorization is invalid or expired"
                              : message,
                      },
                      id: null,
                    }),
                    {
                      status,
                      headers: {
                        "Content-Type": "application/json",
                        ...withContextAttribution(corsHeaders(request), requestContext),
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

                const requestContext = resolveRequestContext(
                  request,
                  sessionId,
                  options.connectionTracker,
                  sessionContexts,
                );
                sessionContexts.delete(sessionId);
                await options.onSessionClose?.(sessionId, requestContext);
                return new Response(null, {
                  status: 204,
                  headers: withContextAttribution(corsHeaders(request), requestContext),
                });
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
      sessionContexts.clear();
      options.managementCredentials?.clear();
      options.workspaceMcpCredentials?.clear();
      await transport.close();
    },
  };

  return handle;
}

type BridgeLeaseRoute = { kind: "acquire" } | { kind: "heartbeat" | "release"; leaseId: string };

type ControlPlaneRoute =
  | { kind: "status" }
  | { kind: "servers" }
  | { kind: "server"; serverId: string }
  | { kind: "features" }
  | { kind: "sessions" }
  | { kind: "metrics" }
  | { kind: "events"; limit: number }
  | { kind: "restart" }
  | { kind: "workspaces" }
  | { kind: "workspace-activate"; workspaceId: string }
  | { kind: "workspace-mcp"; workspaceId: string }
  | { kind: "workspace-status"; workspaceId: string }
  | { kind: "workspace-servers"; workspaceId: string }
  | { kind: "workspace-server"; workspaceId: string; serverId: string }
  | { kind: "workspace-features"; workspaceId: string }
  | { kind: "workspace-sessions"; workspaceId: string }
  | { kind: "workspace-metrics"; workspaceId: string }
  | { kind: "workspace-events"; workspaceId: string; limit: number }
  | {
      kind: "workspace-tools";
      workspaceId: string;
      filter: string;
      query?: string;
      cursor?: string;
      limit?: number;
      includeSchema?: boolean;
    }
  | { kind: "workspace-tool-search"; workspaceId: string }
  | { kind: "workspace-tool-call"; workspaceId: string }
  | { kind: "workspace-code-run"; workspaceId: string }
  | { kind: "workspace-job"; workspaceId: string; jobId: string }
  | { kind: "invalid"; message: string };

type ManagementCredentialRoute =
  | { kind: "handoff" }
  | { kind: "workspace-mcp-credential" }
  | { kind: "browser-devices" }
  | { kind: "browser-device"; deviceId: string }
  | { kind: "browser-challenge" }
  | { kind: "browser-exchange" }
  | { kind: "invalid"; message: string };

function parseManagementCredentialPath(url: URL): ManagementCredentialRoute | null {
  if (url.pathname === MANAGEMENT_CREDENTIAL_HANDOFF_PATH) {
    return url.search
      ? { kind: "invalid", message: "The management handoff does not accept query parameters" }
      : { kind: "handoff" };
  }
  if (url.pathname === WORKSPACE_MCP_CREDENTIAL_PATH) {
    return url.search
      ? {
          kind: "invalid",
          message: "The workspace MCP credential does not accept query parameters",
        }
      : { kind: "workspace-mcp-credential" };
  }
  if (
    url.pathname === CONTROL_PLANE_BROWSER_DEVICES_PATH ||
    url.pathname === CONTROL_PLANE_BROWSER_CHALLENGE_PATH ||
    url.pathname === CONTROL_PLANE_BROWSER_EXCHANGE_PATH
  ) {
    if (url.search) {
      return {
        kind: "invalid",
        message: "Browser management endpoints do not accept query parameters",
      };
    }
    if (url.pathname === CONTROL_PLANE_BROWSER_DEVICES_PATH) return { kind: "browser-devices" };
    if (url.pathname === CONTROL_PLANE_BROWSER_CHALLENGE_PATH) return { kind: "browser-challenge" };
    return { kind: "browser-exchange" };
  }
  if (url.pathname.startsWith(`${CONTROL_PLANE_BROWSER_DEVICES_PATH}/`)) {
    if (url.search) {
      return {
        kind: "invalid",
        message: "Browser device endpoints do not accept query parameters",
      };
    }
    const rawDeviceId = url.pathname.slice(`${CONTROL_PLANE_BROWSER_DEVICES_PATH}/`.length);
    const deviceId = decodePathPart(rawDeviceId);
    if (!deviceId || deviceId.includes("/")) {
      return { kind: "invalid", message: "Browser device endpoint requires one device ID" };
    }
    return { kind: "browser-device", deviceId };
  }
  return null;
}

function parseControlPlanePath(url: URL): ControlPlaneRoute | null {
  const workspacePrefix = `${CONTROL_PLANE_PATH}/workspaces/`;
  if (url.pathname.startsWith(workspacePrefix)) {
    const rawParts = url.pathname.slice(workspacePrefix.length).split("/");
    if (url.search && rawParts[1] !== "events" && rawParts[1] !== "tools") {
      return {
        kind: "invalid",
        message: "Workspace control-plane endpoints do not accept query parameters",
      };
    }

    const parts = rawParts;
    const workspaceId = parts[0] ? decodePathPart(parts[0]) : null;
    if (!workspaceId || workspaceId.includes("/") || !isValidWorkspaceId(workspaceId)) {
      return { kind: "invalid", message: "Invalid workspace ID" };
    }

    if (parts.length === 2) {
      switch (parts[1]) {
        case "activate":
          return { kind: "workspace-activate", workspaceId };
        case "mcp":
          return { kind: "workspace-mcp", workspaceId };
        case "status":
          return { kind: "workspace-status", workspaceId };
        case "servers":
          return { kind: "workspace-servers", workspaceId };
        case "features":
          return { kind: "workspace-features", workspaceId };
        case "sessions":
          return { kind: "workspace-sessions", workspaceId };
        case "metrics":
          return { kind: "workspace-metrics", workspaceId };
        case "events": {
          const rawLimit = url.searchParams.get("limit");
          if (url.searchParams.size > (rawLimit === null ? 0 : 1)) {
            return { kind: "invalid", message: "Only the limit query parameter is supported" };
          }
          if (rawLimit === null) {
            return {
              kind: "workspace-events",
              workspaceId,
              limit: CONTROL_PLANE_DEFAULT_EVENT_LIMIT,
            };
          }
          if (!/^\d+$/.test(rawLimit)) {
            return {
              kind: "invalid",
              message: "The limit query parameter must be a positive integer",
            };
          }
          const parsed = Number(rawLimit);
          if (!Number.isSafeInteger(parsed)) {
            return { kind: "invalid", message: "The limit query parameter is too large" };
          }
          return {
            kind: "workspace-events",
            workspaceId,
            limit: Math.min(Math.max(parsed, 1), CONTROL_PLANE_MAX_EVENT_LIMIT),
          };
        }
        case "tools": {
          const allowedParameters = new Set([
            "filter",
            "query",
            "limit",
            "cursor",
            "includeSchema",
          ]);
          for (const [name] of url.searchParams) {
            if (!allowedParameters.has(name)) {
              return { kind: "invalid", message: `Unsupported tools query parameter: ${name}` };
            }
          }
          for (const name of allowedParameters) {
            if (url.searchParams.getAll(name).length > 1) {
              return { kind: "invalid", message: `The ${name} query parameter cannot be repeated` };
            }
          }

          const rawQuery = url.searchParams.get("query");
          const rawFilter = url.searchParams.get("filter");
          if (rawQuery !== null) {
            if (rawFilter !== null) {
              return {
                kind: "invalid",
                message: "The filter and query parameters cannot be combined",
              };
            }
            const rawLimit = url.searchParams.get("limit");
            let limit: number | undefined;
            if (rawLimit !== null) {
              if (!/^\d+$/u.test(rawLimit)) {
                return { kind: "invalid", message: "The limit query parameter must be an integer" };
              }
              limit = Number(rawLimit);
              if (!Number.isSafeInteger(limit)) {
                return { kind: "invalid", message: "The limit query parameter is too large" };
              }
            }
            const rawIncludeSchema = url.searchParams.get("includeSchema");
            let includeSchema: boolean | undefined;
            if (rawIncludeSchema !== null) {
              if (!/^(?:true|false)$/iu.test(rawIncludeSchema)) {
                return {
                  kind: "invalid",
                  message: "The includeSchema query parameter must be true or false",
                };
              }
              includeSchema = rawIncludeSchema.toLowerCase() === "true";
            }
            return {
              kind: "workspace-tools",
              workspaceId,
              filter: "",
              query: rawQuery,
              ...(url.searchParams.has("cursor")
                ? { cursor: url.searchParams.get("cursor") ?? "" }
                : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(includeSchema !== undefined ? { includeSchema } : {}),
            };
          }

          if (
            url.searchParams.has("limit") ||
            url.searchParams.has("cursor") ||
            url.searchParams.has("includeSchema")
          ) {
            return { kind: "invalid", message: "Paging parameters require an explicit query" };
          }
          if (rawFilter !== null && (rawFilter.length === 0 || rawFilter.length > 256)) {
            return { kind: "invalid", message: "The filter query parameter is invalid" };
          }
          return { kind: "workspace-tools", workspaceId, filter: rawFilter ?? "" };
        }
        case "tool-calls":
        case "tools-call":
          return url.search
            ? {
                kind: "invalid",
                message: "The tool call endpoint does not accept query parameters",
              }
            : { kind: "workspace-tool-call", workspaceId };
        case "code-runs":
          return url.search
            ? {
                kind: "invalid",
                message: "The code-runs endpoint does not accept query parameters",
              }
            : { kind: "workspace-code-run", workspaceId };
        case "jobs": {
          if (url.search) {
            return {
              kind: "invalid",
              message: "The jobs endpoint does not accept query parameters",
            };
          }
          return { kind: "invalid", message: "A job ID is required" };
        }
        default:
          return { kind: "invalid", message: "Invalid workspace control-plane path" };
      }
    }

    if (parts.length === 3 && parts[1] === "servers") {
      const serverId = parts[2] ? decodePathPart(parts[2]) : null;
      if (!serverId) {
        return { kind: "invalid", message: "The workspace server endpoint requires one server ID" };
      }
      return { kind: "workspace-server", workspaceId, serverId };
    }

    if (parts.length === 3 && parts[1] === "jobs") {
      if (url.search) {
        return { kind: "invalid", message: "Job endpoints do not accept query parameters" };
      }
      const jobId = parts[2] ? decodePathPart(parts[2]) : null;
      if (!jobId || jobId.length > 128 || jobId.includes("/")) {
        return { kind: "invalid", message: "The job endpoint requires one job ID" };
      }
      return { kind: "workspace-job", workspaceId, jobId };
    }

    // Keep the public control API nouns aligned with the hosted console. The
    // legacy tool-calls/code-runs spellings above remain accepted for clients
    // that adopted the initial execution API draft.
    if (parts.length === 3 && parts[1] === "tools" && parts[2] === "search") {
      return url.search
        ? { kind: "invalid", message: "The tool search endpoint does not accept query parameters" }
        : { kind: "workspace-tool-search", workspaceId };
    }
    if (parts.length === 3 && parts[1] === "tools" && parts[2] === "call") {
      return url.search
        ? { kind: "invalid", message: "The tool call endpoint does not accept query parameters" }
        : { kind: "workspace-tool-call", workspaceId };
    }
    if (parts.length === 3 && parts[1] === "code" && parts[2] === "execute") {
      return url.search
        ? {
            kind: "invalid",
            message: "The code execution endpoint does not accept query parameters",
          }
        : { kind: "workspace-code-run", workspaceId };
    }

    return { kind: "invalid", message: "Invalid workspace control-plane path" };
  }

  const serversPrefix = `${CONTROL_PLANE_PATH}/servers/`;
  if (url.pathname.startsWith(serversPrefix)) {
    if (url.search) {
      return { kind: "invalid", message: "The server endpoint does not accept query parameters" };
    }
    const suffix = url.pathname.slice(serversPrefix.length);
    if (!suffix || suffix.includes("/")) {
      return { kind: "invalid", message: "The server endpoint requires one server ID" };
    }
    const serverId = decodePathPart(suffix);
    if (!serverId) {
      return { kind: "invalid", message: "The server endpoint requires one server ID" };
    }
    return { kind: "server", serverId };
  }

  switch (url.pathname) {
    case `${CONTROL_PLANE_PATH}/status`:
      return url.search
        ? { kind: "invalid", message: "The status endpoint does not accept query parameters" }
        : { kind: "status" };
    case `${CONTROL_PLANE_PATH}/servers`:
      return url.search
        ? { kind: "invalid", message: "The servers endpoint does not accept query parameters" }
        : { kind: "servers" };
    case `${CONTROL_PLANE_PATH}/features`:
      return url.search
        ? { kind: "invalid", message: "The features endpoint does not accept query parameters" }
        : { kind: "features" };
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
    case `${CONTROL_PLANE_PATH}/workspaces`:
      return url.search
        ? { kind: "invalid", message: "The workspaces endpoint does not accept query parameters" }
        : { kind: "workspaces" };
    default:
      break;
  }

  return null;
}

async function handleControlPlaneRequest(
  request: Request,
  route: ControlPlaneRoute,
  controlPlane: ControlPlane,
  headers: (request: Request) => Record<string, string>,
  options: HttpServerOptions,
  sessionContexts: Map<string, HttpRequestContext>,
): Promise<Response> {
  const responseHeaders = withWorkspaceAttribution(
    headers(request),
    getControlPlaneRouteWorkspaceId(route) ?? controlPlane.getCurrentWorkspaceId(),
  );

  if (route.kind === "invalid") {
    return jsonResponse({ error: "Invalid request", message: route.message }, 400, responseHeaders);
  }

  const workspaceId = getControlPlaneRouteWorkspaceId(route);
  if (workspaceId && !controlPlane.isWorkspaceRegistered(workspaceId)) {
    return jsonResponse(
      {
        error: "workspace-not-found",
        message: "Workspace is not registered with this daemon host",
      },
      404,
      responseHeaders,
    );
  }

  if (route.kind === "workspace-mcp") {
    return handleWorkspaceMcpRequest(request, route.workspaceId, options, sessionContexts, headers);
  }

  if (route.kind === "workspace-activate") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }

    try {
      const result = await controlPlane.activateWorkspace(route.workspaceId);
      const status = result.state === "ready" ? 200 : result.state === "initializing" ? 202 : 409;
      return jsonResponse(result, status, responseHeaders);
    } catch (error) {
      return managementErrorResponse(error, responseHeaders);
    }
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

  if (route.kind === "workspace-tools") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    try {
      const tools =
        route.query === undefined
          ? controlPlane.listWorkspaceTools(route.workspaceId, route.filter)
          : controlPlane.queryWorkspaceTools(route.workspaceId, route.query, {
              ...(route.cursor !== undefined ? { cursor: route.cursor } : {}),
              ...(route.limit !== undefined ? { limit: route.limit } : {}),
              ...(route.includeSchema !== undefined ? { includeSchema: route.includeSchema } : {}),
            });
      return tools
        ? jsonResponse(tools, 200, responseHeaders)
        : executionUnavailableResponse(responseHeaders);
    } catch (error) {
      return executionErrorResponse(error, responseHeaders);
    }
  }

  if (route.kind === "workspace-tool-search") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    try {
      const body = await parseManagementJsonBody(request);
      const searchRequest = parseExecutionSearchRequest(body);
      const result =
        searchRequest.kind === "task"
          ? controlPlane.searchWorkspaceTools(route.workspaceId, searchRequest.task)
          : controlPlane.queryWorkspaceTools(
              route.workspaceId,
              searchRequest.query,
              searchRequest.options,
            );
      return result
        ? jsonResponse(result, 200, responseHeaders)
        : executionUnavailableResponse(responseHeaders);
    } catch (error) {
      return executionErrorResponse(error, responseHeaders);
    }
  }

  if (route.kind === "workspace-tool-call" || route.kind === "workspace-code-run") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    try {
      const body = await parseManagementJsonBody(request);
      const executionRequest =
        route.kind === "workspace-tool-call"
          ? parseExecutionToolCall(body)
          : parseExecutionCodeRun(body);
      const job = controlPlane.submitWorkspaceExecution(route.workspaceId, executionRequest);
      return jsonResponse({ job }, 202, responseHeaders);
    } catch (error) {
      return executionErrorResponse(error, responseHeaders);
    }
  }

  if (route.kind === "workspace-job") {
    if (request.method === "GET" || request.method === "DELETE") {
      const job =
        request.method === "GET"
          ? controlPlane.getWorkspaceJob(route.workspaceId, route.jobId)
          : controlPlane.cancelWorkspaceJob(route.workspaceId, route.jobId);
      return job
        ? jsonResponse({ job }, 200, responseHeaders)
        : jsonResponse(
            { error: "job-not-found", message: "Execution job was not found" },
            404,
            responseHeaders,
          );
    }
    return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
  }

  if (route.kind === "features") {
    if (request.method === "GET") {
      try {
        const features = await controlPlane.getFeatures();
        return features
          ? jsonResponse({ features }, 200, responseHeaders)
          : new Response("Not Found", { status: 404, headers: responseHeaders });
      } catch (error) {
        return managementErrorResponse(error, responseHeaders);
      }
    }

    if (request.method === "PATCH") {
      return handleFeaturesPatch(request, controlPlane, responseHeaders);
    }

    return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
  }

  if (route.kind === "workspace-features") {
    if (request.method === "GET") {
      try {
        const features = await controlPlane.getWorkspaceFeatures(route.workspaceId);
        return features
          ? jsonResponse({ features }, 200, responseHeaders)
          : new Response("Not Found", { status: 404, headers: responseHeaders });
      } catch (error) {
        return managementErrorResponse(error, responseHeaders);
      }
    }

    if (request.method === "PATCH") {
      return handleFeaturesPatch(request, controlPlane, responseHeaders, route.workspaceId);
    }

    return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
  }

  if (route.kind === "workspace-sessions") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    const sessions = controlPlane.getWorkspaceSessions(route.workspaceId);
    return sessions
      ? jsonResponse({ sessions }, 200, responseHeaders)
      : jsonResponse(
          {
            error: "workspace-not-found",
            message: "Workspace is not registered with this daemon host",
          },
          404,
          responseHeaders,
        );
  }

  if (route.kind === "workspace-metrics") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    const metrics = controlPlane.getWorkspaceMetrics(route.workspaceId);
    return metrics
      ? jsonResponse({ metrics }, 200, responseHeaders)
      : jsonResponse(
          {
            error: "workspace-not-found",
            message: "Workspace is not registered with this daemon host",
          },
          404,
          responseHeaders,
        );
  }

  if (route.kind === "workspace-events") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    const events = controlPlane.getWorkspaceEvents(route.workspaceId, route.limit);
    return events
      ? jsonResponse({ events }, 200, responseHeaders)
      : jsonResponse(
          {
            error: "workspace-not-found",
            message: "Workspace is not registered with this daemon host",
          },
          404,
          responseHeaders,
        );
  }

  if (route.kind === "server") {
    if (request.method !== "PATCH") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    return handleServerPatch(request, route.serverId, controlPlane, responseHeaders);
  }

  if (route.kind === "workspace-server") {
    if (request.method !== "PATCH") {
      return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
    }
    return handleServerPatch(
      request,
      route.serverId,
      controlPlane,
      responseHeaders,
      route.workspaceId,
    );
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
    case "workspaces":
      return jsonResponse({ workspaces: controlPlane.getWorkspaces() }, 200, responseHeaders);
    case "workspace-status": {
      const status = await controlPlane.getWorkspaceStatusAsync(route.workspaceId);
      return status
        ? jsonResponse(status, 200, responseHeaders)
        : jsonResponse({ error: "Workspace not found" }, 404, responseHeaders);
    }
    case "workspace-servers": {
      const status = await controlPlane.getWorkspaceStatusAsync(route.workspaceId);
      return status
        ? jsonResponse({ servers: status.servers }, 200, responseHeaders)
        : jsonResponse({ error: "Workspace not found" }, 404, responseHeaders);
    }
  }
}

/**
 * Serve MCP directly for one registered workspace. Unlike the legacy `/mcp`
 * bridge endpoint, the workspace is selected by the already-authorized URL
 * path and is therefore never inferred from caller-supplied directory data.
 */
async function handleWorkspaceMcpRequest(
  request: Request,
  workspaceId: string,
  options: HttpServerOptions,
  sessionContexts: Map<string, HttpRequestContext>,
  headers: (request: Request) => Record<string, string>,
): Promise<Response> {
  const responseHeaders = withWorkspaceAttribution(headers(request), workspaceId);

  if (!options.dispatchMcp) {
    return new Response("Not Found", { status: 404, headers: responseHeaders });
  }

  if (request.method === "POST") {
    const requestStartedAt = performance.now();
    let requestMethod: string | undefined;
    let requestContext: HttpRequestContext | undefined;
    let sessionId = readContextHeader(request, "mcp-session-id");
    let newlyBound = false;

    try {
      sessionId ??= randomUUID();
      const existingContext = sessionContexts.get(sessionId);
      if (existingContext?.workspaceId && existingContext.workspaceId !== workspaceId) {
        throw new BridgeRequestContextError(
          "MCP session is already bound to another workspace",
          400,
        );
      }
      requestContext = { ...existingContext, workspaceId };
      if (!existingContext) newlyBound = true;
      // Bind before dispatch so concurrent requests cannot move a new session
      // between workspace URLs while its initialize request is in flight.
      sessionContexts.set(sessionId, requestContext);

      const body = (await readBoundedJsonBody(
        request,
        MANAGEMENT_BODY_LIMIT_BYTES,
        "MCP request",
      )) as JSONRPCMessage;
      requestMethod = getJsonRpcMethod(body);
      const response = await options.dispatchMcp(body, sessionId, requestContext);
      const protocolError = isJsonRpcProtocolError(response);
      const resultError = isJsonRpcResultError(response);

      if (requestMethod === "initialize" && response && !protocolError) {
        await options.onSessionInitialize?.(
          sessionId,
          getInitializeClientInfo(body),
          requestContext,
        );
      }

      recordMcpObservation(options.controlPlane, {
        durationMs: performance.now() - requestStartedAt,
        method: requestMethod,
        error: protocolError,
        resultError,
        workspaceId,
      });

      if (response) {
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Mcp-Session-Id": sessionId,
            ...withContextAttribution(headers(request), requestContext),
          },
        });
      }

      return new Response(null, {
        status: 202,
        headers: {
          "Cache-Control": "no-store",
          "Mcp-Session-Id": sessionId,
          ...withContextAttribution(headers(request), requestContext),
        },
      });
    } catch (error) {
      if (newlyBound && sessionId && sessionContexts.get(sessionId) === requestContext) {
        sessionContexts.delete(sessionId);
      }

      recordMcpObservation(options.controlPlane, {
        durationMs: performance.now() - requestStartedAt,
        method: requestMethod,
        error: true,
        workspaceId,
      });
      const message = sanitizeControlError(error);
      const status =
        error instanceof RequestBodyLimitError
          ? 413
          : error instanceof BridgeRequestContextError
            ? error.statusCode
            : 500;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: status === 413 ? -32600 : -32603,
            message: status === 413 ? "MCP request body is too large" : message,
          },
          id: null,
        }),
        {
          status,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            ...withContextAttribution(headers(request), requestContext),
          },
        },
      );
    }
  }

  if (request.method === "DELETE") {
    const sessionId = readContextHeader(request, "mcp-session-id");
    if (!sessionId) {
      return new Response("Mcp-Session-Id is required", { status: 400, headers: responseHeaders });
    }

    const existingContext = sessionContexts.get(sessionId);
    if (existingContext?.workspaceId && existingContext.workspaceId !== workspaceId) {
      return new Response("MCP session is already bound to another workspace", {
        status: 400,
        headers: responseHeaders,
      });
    }
    const requestContext = { ...existingContext, workspaceId };
    sessionContexts.delete(sessionId);
    await options.onSessionClose?.(sessionId, requestContext);
    return new Response(null, {
      status: 204,
      headers: withContextAttribution(responseHeaders, requestContext),
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
}

function recordMcpObservation(
  controlPlane: ControlPlane | undefined,
  observation: {
    durationMs: number;
    method?: string;
    error?: boolean;
    resultError?: boolean;
    workspaceId: string;
  },
): void {
  controlPlane?.recordRequest(observation);
  controlPlane?.recordEvent({
    level: observation.error || observation.resultError ? "warn" : "debug",
    type: observation.error ? "mcp.error" : "mcp.request",
    message: observation.error
      ? `${observation.method ?? "request"} failed`
      : `${observation.method ?? "request"} completed`,
    workspaceId: observation.workspaceId,
    metadata: {
      ...(observation.method ? { method: observation.method } : {}),
      workspaceId: observation.workspaceId,
      latencyMs: Math.round(observation.durationMs),
    },
  });
}

async function handleServerPatch(
  request: Request,
  serverId: string,
  controlPlane: ControlPlane,
  responseHeaders: Record<string, string>,
  workspaceId?: string,
): Promise<Response> {
  const expectedDigest = requireIfMatch(request);
  if (!expectedDigest) {
    return jsonResponse(
      {
        error: "precondition-required",
        message: "If-Match must contain the current config digest",
      },
      428,
      responseHeaders,
    );
  }

  try {
    const patch = parseServerEnabledPatch(await parseManagementJsonBody(request));
    const result = workspaceId
      ? await controlPlane.updateWorkspaceServer(workspaceId, serverId, patch, expectedDigest)
      : await controlPlane.updateServer(serverId, patch, expectedDigest);
    return jsonResponse(
      workspaceId ? sanitizeMutationResult(result) : { mutation: sanitizeMutationResult(result) },
      result.accepted ? 202 : 409,
      responseHeaders,
    );
  } catch (error) {
    return managementErrorResponse(error, responseHeaders);
  }
}

async function handleFeaturesPatch(
  request: Request,
  controlPlane: ControlPlane,
  responseHeaders: Record<string, string>,
  workspaceId?: string,
): Promise<Response> {
  const expectedDigest = requireIfMatch(request);
  if (!expectedDigest) {
    return jsonResponse(
      {
        error: "precondition-required",
        message: "If-Match must contain the current config digest",
      },
      428,
      responseHeaders,
    );
  }

  try {
    const patch = parseExecutionModePatch(await parseManagementJsonBody(request));
    const result = workspaceId
      ? await controlPlane.updateWorkspaceFeatures(workspaceId, patch, expectedDigest)
      : await controlPlane.updateFeatures(patch, expectedDigest);
    return jsonResponse(
      workspaceId ? sanitizeMutationResult(result) : { mutation: sanitizeMutationResult(result) },
      result.accepted ? 202 : 409,
      responseHeaders,
    );
  } catch (error) {
    return managementErrorResponse(error, responseHeaders);
  }
}

function requireIfMatch(request: Request): string | null {
  const value = request.headers.get("if-match")?.trim();
  return value && !value.includes(",") ? value : null;
}

function managementErrorResponse(error: unknown, headers: Record<string, string>): Response {
  if (error instanceof ControlPlaneWorkspaceNotFoundError) {
    return jsonResponse(
      { error: error.code, message: "Workspace is not registered with this daemon host" },
      error.status,
      headers,
    );
  }

  if (error instanceof ConfigMutationError) {
    return jsonResponse(
      {
        error: error.code,
        message: sanitizeControlError(error),
        ...(error.details ? sanitizeMutationDetails(error.details) : {}),
      },
      error.status,
      headers,
    );
  }

  return jsonResponse(
    { error: "management-failed", message: sanitizeControlError(error) },
    500,
    headers,
  );
}

function executionUnavailableResponse(headers: Record<string, string>): Response {
  return jsonResponse(
    { error: "not-ready", message: "Workspace runtime is not ready for execution" },
    409,
    headers,
  );
}

function executionErrorResponse(error: unknown, headers: Record<string, string>): Response {
  if (error instanceof ExecutionError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status, headers);
  }
  if (error instanceof ExecutionJobQueueFullError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status, headers);
  }
  if (error instanceof RequestBodyLimitError) {
    return jsonResponse(
      { error: "request-too-large", message: "Execution request body is too large" },
      413,
      headers,
    );
  }
  return jsonResponse(
    { error: "execution-failed", message: "The execution request could not be accepted" },
    500,
    headers,
  );
}

function parseExecutionSearchRequest(value: unknown):
  | { kind: "task"; task: string }
  | {
      kind: "query";
      query: string;
      options: { cursor?: unknown; limit?: unknown; includeSchema?: unknown };
    } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("Request body must be a JSON object", "invalid-request", 400);
  }
  const body = value as Record<string, unknown>;
  if (body.query !== undefined) {
    if (body.task !== undefined) {
      throw new ExecutionError("task and query cannot be used together", "invalid-request", 400);
    }
    if (typeof body.query !== "string") {
      throw new ExecutionError("query must be a string", "invalid-request", 400);
    }
    return {
      kind: "query",
      query: body.query,
      options: {
        ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        ...(body.includeSchema !== undefined ? { includeSchema: body.includeSchema } : {}),
      },
    };
  }
  if (body.cursor !== undefined || body.limit !== undefined || body.includeSchema !== undefined) {
    throw new ExecutionError(
      "cursor, limit, and includeSchema require query mode",
      "invalid-request",
      400,
    );
  }
  const task = body.task;
  if (typeof task !== "string" || task.trim().length === 0 || task.length > 2_048) {
    throw new ExecutionError(
      "task is required and must be at most 2048 characters",
      "invalid-request",
      400,
    );
  }
  return { kind: "task", task };
}

function parseExecutionToolCall(value: unknown): {
  operation: "tool-call";
  name: string;
  arguments?: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("Request body must be a JSON object", "invalid-request", 400);
  }
  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 512) {
    throw new ExecutionError(
      "name is required and must be at most 512 characters",
      "invalid-request",
      400,
    );
  }
  return {
    operation: "tool-call",
    name: body.name,
    ...(body.arguments !== undefined ? { arguments: body.arguments } : {}),
  };
}

function parseExecutionCodeRun(value: unknown): { operation: "code-run"; code: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("Request body must be a JSON object", "invalid-request", 400);
  }
  const code = (value as Record<string, unknown>).code;
  if (typeof code !== "string" || code.trim().length === 0 || code.length > 64 * 1024) {
    throw new ExecutionError(
      "code is required and must be at most 65536 characters",
      "invalid-request",
      400,
    );
  }
  return { operation: "code-run", code };
}

function sanitizeMutationResult(result: ControlPlaneMutationResult): ControlPlaneMutationResult {
  const restart = result.restart
    ? {
        accepted: result.restart.accepted === true,
        message: sanitizeText(result.restart.message),
        ...(result.restart.state ? { state: result.restart.state } : {}),
        ...(result.restart.restartId ? { restartId: sanitizeText(result.restart.restartId) } : {}),
      }
    : undefined;
  const reload = result.reload
    ? {
        accepted: result.reload.accepted === true,
        message: sanitizeText(result.reload.message),
        ...(result.reload.state ? { state: result.reload.state } : {}),
        ...(result.reload.reloadId ? { reloadId: sanitizeText(result.reload.reloadId) } : {}),
      }
    : undefined;

  return {
    accepted: result.accepted === true,
    changed: result.changed === true,
    mutationId: sanitizeText(result.mutationId),
    configDigest: sanitizeText(result.configDigest),
    previousConfigDigest: sanitizeText(result.previousConfigDigest),
    restartState: isManagementRestartState(result.restartState) ? result.restartState : "failed",
    ...(restart ? { restart } : {}),
    ...(reload ? { reload } : {}),
  };
}

function sanitizeMutationDetails(
  details: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      sanitizeText(key),
      typeof value === "string" ? sanitizeText(value) : value,
    ]),
  );
}

function isManagementRestartState(
  value: string,
): value is ControlPlaneMutationResult["restartState"] {
  return value === "idle" || value === "scheduled" || value === "restarting" || value === "failed";
}

async function handleManagementCredentialRequest(
  request: Request,
  route: ManagementCredentialRoute,
  credentials: ManagementCredentialStore,
  headers: (request: Request) => Record<string, string>,
): Promise<Response> {
  if (route.kind === "invalid") {
    return jsonResponse(
      { error: "Invalid request", message: route.message },
      400,
      headers(request),
    );
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: headers(request) });
  }

  try {
    const body = await readBoundedJsonBody(
      request,
      MAX_MANAGEMENT_HANDOFF_BODY_BYTES,
      "management handoff",
      true,
    );
    const workspaceId = parseManagementHandoffWorkspace(body, credentials);
    const grant = credentials.issue(workspaceId);
    return jsonResponse(grant, 201, withWorkspaceAttribution(headers(request), grant.workspaceId));
  } catch (error) {
    const status = error instanceof RequestBodyLimitError ? 413 : 400;
    return jsonResponse(
      {
        error: "invalid-request",
        message:
          status === 413 ? "Management handoff body is too large" : "Invalid management handoff",
      },
      status,
      headers(request),
    );
  }
}

async function handleWorkspaceMcpCredentialRequest(
  request: Request,
  credentials: ManagementCredentialStore | WorkspaceMcpCredentialStore,
  headers: (request: Request) => Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: headers(request) });
  }

  try {
    const body = await readBoundedJsonBody(
      request,
      MAX_MANAGEMENT_HANDOFF_BODY_BYTES,
      "workspace MCP credential",
      false,
    );
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Workspace MCP credential body must be an object");
    }
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "workspaceId" && key !== "rotate")) {
      throw new Error("Workspace MCP credential body contains an unsupported field");
    }
    if (
      !isValidWorkspaceId(record.workspaceId) ||
      !credentials.canIssueForWorkspace(record.workspaceId)
    ) {
      throw new Error("Workspace MCP credential workspace is not available");
    }

    if (credentials instanceof WorkspaceMcpCredentialStore) {
      if (record.rotate !== undefined && typeof record.rotate !== "boolean") {
        throw new Error("Workspace MCP credential rotate must be a boolean");
      }
      const result = await credentials.issue(record.workspaceId, {
        rotate: record.rotate === true,
      });
      return jsonResponse(
        result,
        result.created || result.rotated ? 201 : 200,
        withWorkspaceAttribution(headers(request), record.workspaceId),
      );
    }

    const grant = credentials.issue(record.workspaceId);
    return jsonResponse(
      {
        token: grant.token,
        expiresAt: grant.expiresAt,
        scope: "mcp",
        workspaceId: record.workspaceId,
      },
      201,
      withWorkspaceAttribution(headers(request), record.workspaceId),
    );
  } catch (error) {
    const status = error instanceof RequestBodyLimitError ? 413 : 400;
    return jsonResponse(
      {
        error: "invalid-request",
        message:
          status === 413
            ? "Workspace MCP credential body is too large"
            : "Invalid workspace MCP credential request",
      },
      status,
      headers(request),
    );
  }
}

async function handleBrowserManagementRequest(
  request: Request,
  route: ManagementCredentialRoute,
  browserManagement: BrowserManagementSessionStore | undefined,
  credentials: ManagementCredentialStore | undefined,
  headers: (request: Request) => Record<string, string>,
): Promise<Response> {
  const responseHeaders = headers(request);
  if (route.kind === "invalid") {
    return jsonResponse({ error: "invalid-request", message: route.message }, 400, responseHeaders);
  }
  if (!browserManagement)
    return new Response("Not Found", { status: 404, headers: responseHeaders });

  try {
    if (route.kind === "browser-challenge") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
      }
      return jsonResponse(browserManagement.issueChallenge(), 200, responseHeaders);
    }

    if (route.kind === "browser-exchange") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
      }
      if (!credentials) return new Response("Not Found", { status: 404, headers: responseHeaders });
      const input = parseBrowserManagementExchange(
        await readBoundedJsonBody(request, MAX_MANAGEMENT_HANDOFF_BODY_BYTES, "browser exchange"),
      );
      const result = await browserManagement.exchange(input, credentials);
      return jsonResponse(
        result,
        201,
        withWorkspaceAttribution(responseHeaders, result.grant.workspaceId),
      );
    }

    if (route.kind === "browser-devices") {
      if (request.method === "GET") {
        return jsonResponse({ devices: browserManagement.list() }, 200, responseHeaders);
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
      }
      const input = parseBrowserDeviceRegistration(
        await readBoundedJsonBody(
          request,
          MAX_MANAGEMENT_HANDOFF_BODY_BYTES,
          "browser device registration",
        ),
      );
      const device = await browserManagement.register(input);
      return jsonResponse({ device }, 201, responseHeaders);
    }

    if (route.kind === "browser-device") {
      if (request.method !== "DELETE") {
        return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
      }
      const removed = await browserManagement.revoke(route.deviceId);
      return removed
        ? new Response(null, { status: 204, headers: responseHeaders })
        : jsonResponse(
            { error: "device-not-found", message: "Browser device was not found" },
            404,
            responseHeaders,
          );
    }

    return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
  } catch (error) {
    if (error instanceof RequestBodyLimitError) {
      return jsonResponse(
        { error: "request-too-large", message: "Browser management body is too large" },
        413,
        responseHeaders,
      );
    }
    if (error instanceof BrowserManagementError) {
      const status =
        error.code === "DEVICE_NOT_FOUND" || error.code === "CHALLENGE_NOT_FOUND"
          ? 404
          : error.code === "DEVICE_KEY_MISMATCH" || error.code === "DEVICE_CAPACITY"
            ? 409
            : 400;
      return jsonResponse(
        { error: error.code.toLowerCase(), message: sanitizeControlError(error) },
        status,
        responseHeaders,
      );
    }
    return jsonResponse(
      { error: "management-failed", message: sanitizeControlError(error) },
      500,
      responseHeaders,
    );
  }
}

function parseBrowserDeviceRegistration(value: unknown): {
  deviceId?: string;
  publicKey: unknown;
  label?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserManagementError(
      "Browser device registration must be an object",
      "INVALID_REQUEST",
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["deviceId", "publicKey", "label"].includes(key))) {
    throw new BrowserManagementError(
      "Browser device registration contains an unsupported field",
      "INVALID_REQUEST",
    );
  }
  if (
    record.publicKey === undefined ||
    (record.deviceId !== undefined && typeof record.deviceId !== "string") ||
    (record.label !== undefined && typeof record.label !== "string")
  ) {
    throw new BrowserManagementError("Browser device registration is invalid", "INVALID_REQUEST");
  }
  return {
    publicKey: record.publicKey,
    ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
    ...(record.label === undefined ? {} : { label: record.label }),
  };
}

function parseBrowserManagementExchange(value: unknown): {
  protocolVersion?: "1";
  deviceId: string;
  challengeId: string;
  signature: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserManagementError("Browser exchange must be an object", "INVALID_REQUEST");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["protocolVersion", "deviceId", "challengeId", "signature"].includes(key),
    ) ||
    (record.protocolVersion !== undefined && record.protocolVersion !== "1") ||
    typeof record.deviceId !== "string" ||
    typeof record.challengeId !== "string" ||
    typeof record.signature !== "string"
  ) {
    throw new BrowserManagementError("Browser exchange is invalid", "INVALID_REQUEST");
  }
  return {
    ...(record.protocolVersion === undefined ? {} : { protocolVersion: "1" }),
    deviceId: record.deviceId,
    challengeId: record.challengeId,
    signature: record.signature,
  };
}

function sanitizeControlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message);
}

const MAX_BRIDGE_LEASE_METADATA_BYTES = 16 * 1024;
const MAX_MANAGEMENT_HANDOFF_BODY_BYTES = 4 * 1024;

async function readBridgeLeaseMetadata(request: Request): Promise<BridgeLeaseMetadata | undefined> {
  const value = await readBoundedJsonBody(
    request,
    MAX_BRIDGE_LEASE_METADATA_BYTES,
    "bridge lease metadata",
    true,
  );
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bridge lease metadata must be an object");
  }

  const record = value as Record<string, unknown>;
  const directory = boundedMetadataString(record.directory, 4_096);
  const configPath = boundedMetadataString(record.configPath, 4_096);
  const configDigest = boundedMetadataString(record.configDigest, 128);
  const configScope = record.configScope;
  if (
    !directory ||
    !configPath ||
    !configDigest ||
    (configScope !== "project-local" &&
      configScope !== "user-project" &&
      configScope !== "user-global") ||
    !/^[a-f0-9]{64}$/i.test(configDigest)
  ) {
    throw new Error("Bridge lease metadata is incomplete or invalid");
  }

  const workspaceId = optionalMetadataString(record.workspaceId, 256);
  const profileId = optionalMetadataString(record.profileId, 256);
  if (
    (record.workspaceId !== undefined && !workspaceId) ||
    (record.profileId !== undefined && !profileId)
  ) {
    throw new Error("Bridge lease metadata has an invalid workspace or profile ID");
  }
  return {
    directory,
    configPath,
    configScope,
    configDigest,
    ...(workspaceId ? { workspaceId } : {}),
    ...(profileId ? { profileId } : {}),
  };
}

function parseManagementHandoffWorkspace(
  value: unknown,
  credentials: ManagementCredentialStore,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Management handoff body must be an object");
  }

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "workspaceId")) {
    throw new Error("Management handoff body contains an unsupported field");
  }
  if (record.workspaceId === undefined) return undefined;
  if (!isValidWorkspaceId(record.workspaceId)) {
    throw new Error("Management handoff workspace ID is invalid");
  }
  if (!credentials.canIssueForWorkspace(record.workspaceId)) {
    throw new Error("Management handoff workspace is not available");
  }
  return record.workspaceId;
}

class RequestBodyLimitError extends Error {
  constructor(readonly label: string) {
    super(`${label} body is too large`);
    this.name = "RequestBodyLimitError";
  }
}

async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
  label: string,
  allowEmpty = false,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) {
      throw new Error(`${label} content length is invalid`);
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      throw new RequestBodyLimitError(label);
    }
  }

  if (!request.body) {
    if (allowEmpty) return undefined;
    throw new Error(`${label} body is required`);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(`${label} body exceeds limit`).catch(() => undefined);
        throw new RequestBodyLimitError(label);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0 && allowEmpty) return undefined;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(
      `${label} body must contain valid JSON${error instanceof Error ? `: ${error.message}` : ""}`,
    );
  }
}

function boundedMetadataString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function optionalMetadataString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedMetadataString(value, maxLength);
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
    const leaseId = decodePathPart(parts[0]);
    return leaseId ? { kind: "release", leaseId } : null;
  }
  if (parts.length === 2 && parts[1] === "heartbeat" && parts[0]) {
    const leaseId = decodePathPart(parts[0]);
    return leaseId ? { kind: "heartbeat", leaseId } : null;
  }
  return null;
}

function decodePathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
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
    typeof result === "object" && result !== null && "isError" in result && result.isError === true
  );
}

function isLocalAuthorized(request: Request, authToken: string | undefined): boolean {
  return isAuthorized(request, authToken);
}

function isBrowserManagementAuthorized(request: Request, options: HttpServerOptions): boolean {
  if (isLocalAuthorized(request, options.authToken)) return true;
  const token = getBearerToken(request);
  return options.managementCredentials?.getAuthorization(token)?.authority === "host";
}

function resolveRequestContext(
  request: Request,
  sessionId: string,
  tracker: BridgeLeaseTracker | undefined,
  sessionContexts: ReadonlyMap<string, HttpRequestContext>,
): HttpRequestContext | undefined {
  const sessionContext = sessionContexts.get(sessionId);
  const leaseId = readContextHeader(request, DAEMON_BRIDGE_LEASE_HEADER);
  const requestedWorkspaceId = (() => {
    const value = readContextHeader(request, DAEMON_WORKSPACE_HEADER);
    return value && isValidWorkspaceId(value) ? value : undefined;
  })();

  if (!leaseId && !requestedWorkspaceId) {
    return sessionContext;
  }

  // When the tracker exposes its public lease list, use the server-owned
  // workspace claim instead of trusting a client-supplied workspace ID. This
  // keeps attribution stable even if a bridge reuses a connection with stale
  // metadata. Custom embedders without a lease list retain header-only
  // compatibility, since their tracker may resolve claims out of process.
  if (leaseId && tracker?.leases) {
    const lease = tracker.leases.find((candidate) => candidate.leaseId === leaseId);
    if (!lease) {
      throw new BridgeRequestContextError("MCP bridge lease is unknown or expired", 401);
    }
    return enforceSessionWorkspace(sessionContext, {
      leaseId,
      ...(lease.workspaceId ? { workspaceId: lease.workspaceId } : {}),
    });
  }

  // A direct HTTP caller must not be able to invent a workspace attribution by
  // sending only the public workspace header. The stdio bridge always carries
  // a server-issued lease; custom embedders without a lease list retain the
  // header-only compatibility path below.
  if (requestedWorkspaceId && tracker?.leases) {
    if (!sessionContext) {
      throw new BridgeRequestContextError("MCP workspace selection requires a bridge lease", 400);
    }
    return sessionContext;
  }

  return enforceSessionWorkspace(sessionContext, {
    ...(leaseId ? { leaseId } : {}),
    ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
  });
}

function enforceSessionWorkspace(
  sessionContext: HttpRequestContext | undefined,
  requestContext: HttpRequestContext,
): HttpRequestContext {
  if (
    sessionContext?.workspaceId &&
    requestContext.workspaceId &&
    sessionContext.workspaceId !== requestContext.workspaceId
  ) {
    throw new Error("MCP session is already bound to another workspace");
  }

  return {
    ...sessionContext,
    ...requestContext,
    ...(sessionContext?.workspaceId
      ? { workspaceId: sessionContext.workspaceId }
      : requestContext.workspaceId
        ? { workspaceId: requestContext.workspaceId }
        : {}),
  };
}

function readContextHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value && value.length <= 256 ? value : undefined;
}

function requestContextMetadata(context: HttpRequestContext | undefined): Record<string, string> {
  return {
    ...(context?.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context?.leaseId ? { leaseId: context.leaseId } : {}),
  };
}

function isAuthorized(
  request: Request,
  authToken: string | undefined,
  requireToken = false,
): boolean {
  if (!authToken) return !requireToken;
  return request.headers.get("authorization") === `Bearer ${authToken}`;
}

function isControlPlaneAuthorized(
  request: Request,
  options: HttpServerOptions,
  route: ControlPlaneRoute,
): boolean {
  const workspaceId = getControlPlaneRouteWorkspaceId(route);
  if (workspaceId) {
    if (route.kind === "workspace-mcp") {
      return isWorkspaceMcpAuthorized(request, options, workspaceId);
    }
    return isWorkspaceControlPlaneAuthorized(request, options, workspaceId);
  }
  if (isLocalAuthorized(request, options.authToken)) return true;

  const credentials = options.managementCredentials;
  if (!credentials) return false;

  // The inventory endpoint is a host-level operation because it reveals all
  // registered directories to the workspace switcher. Every other
  // unqualified alias is scoped to the daemon's current handoff workspace; a
  // grant claimed for a different directory must never read or mutate the
  // primary context.
  const token = getBearerToken(request);
  if (route.kind === "workspaces") {
    return credentials.getAuthorization(token)?.authority === "host";
  }
  const currentWorkspaceId = options.controlPlane?.getCurrentWorkspaceId();
  const authorization = credentials.getAuthorization(token);
  if (!authorization) return false;
  return (
    authorization.authority === "host" ||
    (currentWorkspaceId !== null &&
      currentWorkspaceId !== undefined &&
      authorization.workspaceId === currentWorkspaceId)
  );
}

function isWorkspaceMcpAuthorized(
  request: Request,
  options: HttpServerOptions,
  workspaceId: string,
): boolean {
  const credentials = options.workspaceMcpCredentials;
  if (!credentials) return false;
  if (credentials instanceof WorkspaceMcpCredentialStore) {
    return credentials.authorize(getBearerToken(request), workspaceId);
  }
  const authorization = credentials.getAuthorization(getBearerToken(request));
  return authorization?.authority === "workspace" && authorization.workspaceId === workspaceId;
}

function isWorkspaceControlPlaneAuthorized(
  request: Request,
  options: HttpServerOptions,
  workspaceId: string,
): boolean {
  const currentWorkspaceId = options.controlPlane?.getCurrentWorkspaceId();

  // Root daemon credentials are accepted for the authenticated current
  // workspace only. A workspace route must never turn the private root token
  // into a cross-directory capability.
  if (currentWorkspaceId === workspaceId && isAuthorized(request, options.authToken, true)) {
    return true;
  }

  const token = getBearerToken(request);
  const credentials = options.managementCredentials;
  if (!credentials) return false;

  const authorization = credentials.getAuthorization(token);
  if (!authorization) return false;

  // A host grant is explicitly minted by the user-scoped daemon host and may
  // select any registered workspace. A workspace grant retains its original
  // claim and cannot be used to switch contexts.
  return authorization.authority === "host" || authorization.workspaceId === workspaceId;
}

function getControlPlaneRouteWorkspaceId(route: ControlPlaneRoute): string | undefined {
  return "workspaceId" in route ? route.workspaceId : undefined;
}

function withWorkspaceAttribution(
  headers: Record<string, string>,
  workspaceId: string | null | undefined,
): Record<string, string> {
  const safeWorkspaceId = workspaceId && isValidWorkspaceId(workspaceId) ? workspaceId : undefined;
  return safeWorkspaceId ? { ...headers, [DAEMON_WORKSPACE_HEADER]: safeWorkspaceId } : headers;
}

function withLeaseAttribution(
  headers: Record<string, string>,
  lease: Pick<ConnectionLease, "leaseId" | "workspaceId">,
): Record<string, string> {
  const safeLeaseId = safeHeaderValue(lease.leaseId);
  const attributed = safeLeaseId
    ? { ...headers, [DAEMON_BRIDGE_LEASE_HEADER]: safeLeaseId }
    : headers;
  return withWorkspaceAttribution(attributed, lease.workspaceId);
}

function withContextAttribution(
  headers: Record<string, string>,
  context: HttpRequestContext | undefined,
): Record<string, string> {
  const attributed = context?.leaseId
    ? withLeaseAttribution(headers, {
        leaseId: context.leaseId,
        workspaceId: context.workspaceId,
      })
    : headers;
  return withWorkspaceAttribution(attributed, context?.workspaceId);
}

function safeHeaderValue(value: string | undefined): string | undefined {
  return value && value.length <= 256 && !/[\r\n]/.test(value) ? value : undefined;
}

function getBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
}

function jsonResponse(value: unknown, status: number, headers: Record<string, string>): Response {
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
