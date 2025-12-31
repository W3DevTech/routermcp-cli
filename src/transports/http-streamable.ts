import { randomUUID } from "crypto";
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
  start: () => Promise<void>;
  stop: () => Promise<void>;
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

export function createHttpServerTransport(port: number, host = "127.0.0.1"): HttpServerHandle {
  const transport = new BunHttpServerTransport();
  let server: ServerHandle | null = null;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };

  const handle: HttpServerHandle = {
    transport,
    server: null,

    start: async () => {
      server = serve({
        port,
        fetch: async (request: Request) => {
          const url = new URL(request.url);

          if (url.pathname !== "/mcp") {
            return new Response("Not Found", { status: 404 });
          }

          if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
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
                    ...corsHeaders,
                  },
                });
              }

              return new Response(null, {
                status: 202,
                headers: {
                  "Mcp-Session-Id": sessionId,
                  ...corsHeaders,
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
                    ...corsHeaders,
                  },
                },
              );
            }
          }

          return new Response("Method Not Allowed", {
            status: 405,
            headers: corsHeaders,
          });
        },
      });

      handle.server = server;
      console.error(`HTTP MCP server listening on http://${host}:${port}/mcp`);
    },

    stop: async () => {
      if (server) {
        server.stop();
        server = null;
        handle.server = null;
      }
      await transport.close();
    },
  };

  return handle;
}
