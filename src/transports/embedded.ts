import { randomUUID } from "node:crypto";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * A server transport for a gateway embedded in the daemon host.
 *
 * It deliberately has no listener and never reads stdin/stdout. Requests are
 * submitted by the host's shared HTTP transport and responses are resolved
 * back to the submitting request using an internal ID. The public MCP ID and
 * session ID remain unchanged on the wire.
 */
export interface EmbeddedServerTransport extends Transport {
  readonly sessionId: string;
  getCurrentSessionId(): string | null;
  handleRequestWithSession(
    message: JSONRPCMessage,
    sessionId: string,
  ): Promise<JSONRPCMessage | null>;
}

export function createEmbeddedServerTransport(): EmbeddedServerTransport {
  return new EmbeddedTransport();
}

interface PendingRequest {
  resolve: (response: JSONRPCMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  clientRequestId: string | number;
}

class EmbeddedTransport implements EmbeddedServerTransport {
  sessionId = "__embedded__";
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestTimeout = 30_000;
  private started = false;
  private currentSessionId: string | null = null;

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!("id" in message) || message.id === undefined) return;

    const pending = this.pendingRequests.get(message.id.toString());
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id.toString());
    pending.resolve({ ...message, id: pending.clientRequestId } as JSONRPCMessage);
  }

  async close(): Promise<void> {
    this.started = false;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Embedded transport closed"));
    }
    this.pendingRequests.clear();
    this.onclose?.();
  }

  handleRequestWithSession(
    message: JSONRPCMessage,
    sessionId: string,
  ): Promise<JSONRPCMessage | null> {
    if (!this.started) return Promise.reject(new Error("Embedded transport not started"));

    this.currentSessionId = sessionId;
    // Protocol captures transport.sessionId synchronously when it receives a
    // request. This makes the request-scoped session available to Gateway's
    // handlers without creating a transport per MCP session.
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
          reject(new Error("Embedded request timeout"));
        }, this.requestTimeout);
        timeout.unref?.();

        this.pendingRequests.set(internalRequestId, {
          resolve,
          reject,
          timeout,
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

    try {
      this.onmessage?.(message);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(null);
  }
}
