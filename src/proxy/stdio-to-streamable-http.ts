import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type JSONRPCMessage, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { SessionAccessCounter } from "../core/session-counter.js";
import { ChildProcessManager } from "./child-process-manager.js";
import type { HealthResponse, ManagedChildProcess, ProxyOptions } from "./types.js";

interface StatefulSession {
  transport: WebStandardStreamableHTTPServerTransport;
  childManager: ChildProcessManager;
  child: ManagedChildProcess;
  initialized: boolean;
}

export async function startStreamableHttpProxy(options: ProxyOptions): Promise<void> {
  const startTime = Date.now();
  const app = new Hono();

  if (options.cors) {
    app.use("*", cors());
  }

  const basePath = options.basePath.replace(/\/$/, "");
  const mcpPath = `${basePath}${options.streamableHttpPath}`;
  const healthPath = `${basePath}${options.healthEndpoint}`;

  const log = (message: string) => {
    if (options.verbose) {
      console.error(`[StreamableHTTP] ${message}`);
    }
  };

  if (options.stateful) {
    await startStatefulMode(app, options, mcpPath, healthPath, startTime, log);
  } else {
    await startStatelessMode(app, options, mcpPath, healthPath, startTime, log);
  }

  log(`Starting server on port ${options.port}`);
  log(`MCP endpoint: ${mcpPath}`);
  log(`Health endpoint: ${healthPath}`);
  log(`Mode: ${options.stateful ? "stateful" : "stateless"}`);

  serve({
    fetch: app.fetch,
    port: options.port,
  });

  console.error(`Streamable HTTP proxy listening on http://localhost:${options.port}${mcpPath}`);
}

async function startStatelessMode(
  app: Hono,
  options: ProxyOptions,
  mcpPath: string,
  healthPath: string,
  startTime: number,
  log: (msg: string) => void,
): Promise<void> {
  let requestCount = 0;

  app.get(healthPath, (c) => {
    const health: HealthResponse = {
      status: "ok",
      transport: "streamableHttp",
      uptime: Date.now() - startTime,
      childProcess: {
        running: true,
        restartCount: 0,
      },
    };
    return c.json(health);
  });

  app.post(mcpPath, async (c) => {
    requestCount++;
    const reqId = requestCount;
    log(`[req ${reqId}] Incoming POST request`);

    const childManager = new ChildProcessManager({
      command: options.stdioCmd,
      maxRestarts: options.maxRestarts,
      verbose: options.verbose,
    });

    let child: ManagedChildProcess;
    try {
      child = await childManager.spawn();
    } catch (error) {
      log(`[req ${reqId}] Failed to spawn child process: ${error}`);
      return c.json({ error: "Failed to spawn MCP server" }, 500);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    setupChildStdoutHandler(child, transport, log, `req ${reqId}`);

    transport.onmessage = async (message: JSONRPCMessage) => {
      log(`[req ${reqId}] Client -> Server: ${JSON.stringify(message)}`);
      const messageStr = `${JSON.stringify(message)}\n`;
      child.stdin.write(messageStr);
      childManager.resetRestartCount();
    };

    transport.onclose = () => {
      log(`[req ${reqId}] Transport closed, killing child`);
      childManager.kill();
    };

    try {
      const body = await c.req.text();
      const messages = JSON.parse(body);

      const needsAutoInit =
        Array.isArray(messages) &&
        messages.length > 0 &&
        !messages.some((m: JSONRPCMessage) => isInitializeRequest(m));

      if (needsAutoInit) {
        log(`[req ${reqId}] Auto-initializing (no initialize request in batch)`);
        const initMessage: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: `auto-init-${reqId}`,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "routermcp-proxy", version: "1.0.0" },
          },
        };
        child.stdin.write(`${JSON.stringify(initMessage)}\n`);
      }

      const request = new Request(c.req.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body,
      });

      const response = await transport.handleRequest(request);

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      log(`[req ${reqId}] Error handling request: ${error}`);
      childManager.kill();
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.all(mcpPath, (c) => {
    return c.json({ error: "Method not allowed. Stateless mode only supports POST." }, 405);
  });
}

async function startStatefulMode(
  app: Hono,
  options: ProxyOptions,
  mcpPath: string,
  healthPath: string,
  startTime: number,
  log: (msg: string) => void,
): Promise<void> {
  const sessions = new Map<string, StatefulSession>();

  const sessionCounter = new SessionAccessCounter(options.sessionTimeout, (sessionId) => {
    log(`Session ${sessionId} timed out`);
    cleanupSession(sessionId);
  });

  const cleanupSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.childManager.kill();
      sessions.delete(sessionId);
      sessionCounter.remove(sessionId);
      log(`Cleaned up session ${sessionId}`);
    }
  };

  const getOrCreateSession = async (sessionId: string): Promise<StatefulSession> => {
    let session = sessions.get(sessionId);

    if (!session) {
      log(`Creating new session: ${sessionId}`);

      const childManager = new ChildProcessManager({
        command: options.stdioCmd,
        maxRestarts: options.maxRestarts,
        verbose: options.verbose,
        onExit: () => {
          log(`Child process for session ${sessionId} exited`);
          cleanupSession(sessionId);
        },
      });

      const child = await childManager.spawn();

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (sid) => {
          log(`Session initialized: ${sid}`);
        },
      });

      setupChildStdoutHandler(child, transport, log, sessionId);

      transport.onmessage = async (message: JSONRPCMessage) => {
        log(`[${sessionId}] Client -> Server: ${JSON.stringify(message)}`);
        const messageStr = `${JSON.stringify(message)}\n`;
        child.stdin.write(messageStr);
        childManager.resetRestartCount();
      };

      transport.onclose = () => {
        log(`[${sessionId}] Transport closed`);
        cleanupSession(sessionId);
      };

      session = { transport, childManager, child, initialized: false };
      sessions.set(sessionId, session);
    }

    sessionCounter.access(sessionId);
    return session;
  };

  app.get(healthPath, (c) => {
    const health: HealthResponse = {
      status: "ok",
      transport: "streamableHttp",
      uptime: Date.now() - startTime,
      sessions: sessions.size,
      childProcess: {
        running: sessions.size > 0,
        restartCount: 0,
      },
    };
    return c.json(health);
  });

  app.post(mcpPath, async (c) => {
    const sessionId = c.req.header("mcp-session-id") || randomUUID();
    log(`[${sessionId}] POST request`);

    try {
      const session = await getOrCreateSession(sessionId);

      const body = await c.req.text();
      const request = new Request(c.req.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body,
      });

      const response = await session.transport.handleRequest(request);

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      log(`[${sessionId}] Error: ${error}`);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.get(mcpPath, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      return c.json({ error: "Invalid or missing session ID" }, 400);
    }

    log(`[${sessionId}] GET request (SSE stream)`);
    sessionCounter.access(sessionId);

    const session = sessions.get(sessionId)!;
    const request = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
    });

    const response = await session.transport.handleRequest(request);

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  });

  app.delete(mcpPath, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId) {
      return c.json({ error: "Missing session ID" }, 400);
    }

    log(`[${sessionId}] DELETE request`);
    cleanupSession(sessionId);

    return c.json({ status: "session terminated" });
  });

  process.on("SIGINT", () => {
    log("Shutting down...");
    for (const sessionId of sessions.keys()) {
      cleanupSession(sessionId);
    }
    sessionCounter.destroy();
    process.exit(0);
  });
}

function setupChildStdoutHandler(
  child: ManagedChildProcess,
  transport: WebStandardStreamableHTTPServerTransport,
  log: (msg: string) => void,
  logPrefix: string,
): void {
  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as JSONRPCMessage;
      log(`[${logPrefix}] Server -> Client: ${line}`);
      transport.send(message).catch((err) => {
        log(`[${logPrefix}] Failed to send message: ${err}`);
      });
    } catch {
      log(`[${logPrefix}] Non-JSON from child: ${line}`);
    }
  });
}
