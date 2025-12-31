import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/**
 * Gets an available port by creating a server on port 0
 */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not get port"));
      }
    });
    server.on("error", reject);
  });
}

/**
 * Waits for a server to be ready at the given URL
 */
export async function waitForServer(url: string, timeout = 30000, interval = 500): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      // Server is ready if we get any response (even 4xx/5xx means server is up)
      if (response.status) {
        return;
      }
    } catch {
      // Server not ready yet, wait and retry
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Timeout waiting for server at ${url} after ${timeout}ms`);
}

/**
 * Waits for a server health endpoint to return 200
 */
export async function waitForHealthy(url: string, timeout = 30000, interval = 500): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Timeout waiting for healthy server at ${url} after ${timeout}ms`);
}

/**
 * Sends a JSON-RPC request to an MCP server over HTTP
 */
export async function sendMcpRequest(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<{ id: number; result?: unknown; error?: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params: params || {},
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Initializes an MCP session and returns the session ID
 */
export async function initializeMcpSession(
  url: string,
  clientInfo = { name: "test-client", version: "1.0.0" },
): Promise<{ sessionId: string; capabilities: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo,
      },
    }),
  });

  const sessionId = response.headers.get("Mcp-Session-Id");
  if (!sessionId) {
    throw new Error("No session ID in response");
  }

  const data = await response.json();
  return {
    sessionId,
    capabilities: data.result?.capabilities,
  };
}

/**
 * Lists tools from an MCP server
 */
export async function listTools(
  url: string,
  sessionId?: string,
): Promise<Array<{ name: string; description?: string }>> {
  const response = await sendMcpRequest(url, "tools/list", {}, sessionId);
  return (response.result as { tools: Array<{ name: string; description?: string }> })?.tools || [];
}

/**
 * Calls a tool on an MCP server
 */
export async function callTool(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<{ content: unknown[]; isError?: boolean }> {
  const response = await sendMcpRequest(
    url,
    "tools/call",
    { name: toolName, arguments: args },
    sessionId,
  );
  return response.result as { content: unknown[]; isError?: boolean };
}

/**
 * Lists resources from an MCP server
 */
export async function listResources(
  url: string,
  sessionId?: string,
): Promise<Array<{ uri: string; name: string }>> {
  const response = await sendMcpRequest(url, "resources/list", {}, sessionId);
  return (response.result as { resources: Array<{ uri: string; name: string }> })?.resources || [];
}

/**
 * Lists prompts from an MCP server
 */
export async function listPrompts(
  url: string,
  sessionId?: string,
): Promise<Array<{ name: string; description?: string }>> {
  const response = await sendMcpRequest(url, "prompts/list", {}, sessionId);
  return (
    (response.result as { prompts: Array<{ name: string; description?: string }> })?.prompts || []
  );
}

/**
 * Kills a child process and waits for it to exit
 */
export async function killProcess(child: ChildProcess, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);

    child.once("exit", () => {
      clearTimeout(timeoutId);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

/**
 * Creates a simple test MCP client for stdio communication
 */
export class StdioMcpTestClient {
  private child: ChildProcess;
  private messageId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = "";

  constructor(child: ChildProcess) {
    this.child = child;
    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    this.child.stdout?.on("data", (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.id && this.pendingRequests.has(message.id)) {
          const { resolve } = this.pendingRequests.get(message.id)!;
          this.pendingRequests.delete(message.id);
          resolve(message);
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method}`));
      }, 10000);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: params || {},
      });

      this.child.stdin?.write(`${message}\n`);
    });
  }

  async initialize(): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
  }

  async listTools(): Promise<unknown> {
    return this.request("tools/list");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    return killProcess(this.child);
  }
}
