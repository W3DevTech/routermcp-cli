import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config/types.js";
import { TransportError } from "../utils/errors.js";
import { randomUUID } from "crypto";
import { serve, type ServerHandle } from "../compat/index.js";

/**
 * Create an HTTP streamable client transport for connecting to an upstream MCP server.
 */
export async function createHttpClientTransport(
  serverName: string,
  config: ServerConfig
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  if (config.transport !== "http-streamable") {
    throw new TransportError(
      "http-streamable",
      `Expected http-streamable transport, got ${config.transport}`
    );
  }

  if (!config.url) {
    throw new TransportError(
      "http-streamable",
      "URL is required for http-streamable transport"
    );
  }

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.headers,
    },
  });

  const client = new Client(
    {
      name: `routermcp-client-${serverName}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  const cleanup = async () => {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { client, cleanup };
}

/**
 * Server transport handle for HTTP.
 */
export interface HttpServerHandle {
  transport: Transport;
  server: ServerHandle | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Simple JSON-RPC over HTTP transport for Bun.
 * Implements MCP Transport interface for server-side usage.
 */
class BunHttpServerTransport implements Transport {
  sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private pendingResponses = new Map<
    string | number,
    { resolve: (response: JSONRPCMessage) => void; reject: (error: Error) => void }
  >();
  private started = false;

  constructor() {
    this.sessionId = randomUUID();
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    // Handle responses by resolving pending request promises
    if ("id" in message && message.id !== undefined) {
      const pending = this.pendingResponses.get(message.id);
      if (pending) {
        pending.resolve(message);
        this.pendingResponses.delete(message.id);
      }
    }
  }

  async close(): Promise<void> {
    // Reject any pending requests
    for (const [id, pending] of this.pendingResponses) {
      pending.reject(new Error("Transport closed"));
    }
    this.pendingResponses.clear();
    this.onclose?.();
  }

  /**
   * Handle an incoming HTTP request with a JSON-RPC message.
   * Returns a promise that resolves with the response.
   */
  async handleRequest(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    if (!this.started) {
      throw new Error("Transport not started");
    }

    // For requests (messages with id), set up a response promise
    if ("method" in message && "id" in message && message.id !== undefined) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingResponses.delete(message.id!);
          reject(new Error("Request timeout"));
        }, 30000); // 30 second timeout

        this.pendingResponses.set(message.id!, {
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });

        // Pass message to MCP server
        this.onmessage?.(message);
      });
    }

    // For notifications (no id), just pass through
    this.onmessage?.(message);
    return null;
  }
}

/**
 * Create an HTTP server transport for exposing the gateway.
 * Uses compat serve() with simple JSON-RPC over HTTP.
 */
export function createHttpServerTransport(
  port: number,
  host: string = "127.0.0.1"
): HttpServerHandle {
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

          // Only handle /mcp endpoint
          if (url.pathname !== "/mcp") {
            return new Response("Not Found", { status: 404 });
          }

          // Handle CORS preflight
          if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
          }

          // Handle POST requests with JSON-RPC messages
          if (request.method === "POST") {
            try {
              const body = (await request.json()) as JSONRPCMessage;

              const response = await transport.handleRequest(body);

              if (response) {
                return new Response(JSON.stringify(response), {
                  status: 200,
                  headers: {
                    "Content-Type": "application/json",
                    "Mcp-Session-Id": transport.sessionId,
                    ...corsHeaders,
                  },
                });
              }

              // Notification - return accepted
              return new Response(null, {
                status: 202,
                headers: {
                  "Mcp-Session-Id": transport.sessionId,
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
                }
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
