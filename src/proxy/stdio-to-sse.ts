import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ChildProcessManager } from "./child-process-manager.js";
import type { ProxyOptions, HealthResponse, ManagedChildProcess } from "./types.js";

interface SseSession {
  id: string;
  transport: SSEServerTransport;
  response: ServerResponse;
}

export async function startSseProxy(options: ProxyOptions): Promise<void> {
  const startTime = Date.now();
  const sessions = new Map<string, SseSession>();

  const basePath = options.basePath.replace(/\/$/, "");
  const ssePath = `${basePath}${options.ssePath}`;
  const messagePath = `${basePath}${options.messagePath}`;
  const healthPath = `${basePath}${options.healthEndpoint}`;

  const log = (message: string) => {
    if (options.verbose) {
      console.error(`[SSE] ${message}`);
    }
  };

  const childManager = new ChildProcessManager({
    command: options.stdioCmd,
    maxRestarts: options.maxRestarts,
    verbose: options.verbose,
    onExit: async (code, signal) => {
      log(`Child process exited (code: ${code}, signal: ${signal}), attempting restart...`);
      try {
        const newChild = await childManager.restart();
        setupChildStdoutBroadcast(newChild, sessions, log);
        log("Child process restarted successfully");
      } catch (error) {
        console.error(`Failed to restart child process: ${error}`);
        process.exit(1);
      }
    },
  });

  let child: ManagedChildProcess;
  try {
    child = await childManager.spawn();
    log("Child process spawned");
  } catch (error) {
    console.error(`Failed to spawn child process: ${error}`);
    process.exit(1);
  }

  setupChildStdoutBroadcast(child, sessions, log);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (options.cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (pathname === healthPath && req.method === "GET") {
      const health: HealthResponse = {
        status: "ok",
        transport: "sse",
        uptime: Date.now() - startTime,
        sessions: sessions.size,
        childProcess: {
          running: childManager.isRunning,
          restartCount: childManager.restartCount,
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    if (pathname === ssePath && req.method === "GET") {
      const sessionId = randomUUID();
      log(`New SSE connection: ${sessionId}`);

      const transport = new SSEServerTransport(messagePath, res);

      transport.onmessage = async (message: JSONRPCMessage) => {
        log(`[${sessionId}] Client -> Server: ${JSON.stringify(message)}`);
        const messageStr = JSON.stringify(message) + "\n";
        child.stdin.write(messageStr);
        childManager.resetRestartCount();
      };

      transport.onclose = () => {
        log(`[${sessionId}] SSE connection closed`);
        sessions.delete(sessionId);
      };

      sessions.set(sessionId, { id: sessionId, transport, response: res });

      req.on("close", () => {
        log(`[${sessionId}] Client disconnected`);
        sessions.delete(sessionId);
      });

      await transport.start();
      return;
    }

    if (pathname === messagePath && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");

      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId query parameter" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      log(`[${sessionId}] POST message`);

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          await session.transport.handlePostMessage(req, res, body);
        } catch (error) {
          log(`[${sessionId}] Error handling message: ${error}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(options.port, () => {
    console.error(`SSE proxy listening on http://localhost:${options.port}${ssePath}`);
    log(`SSE endpoint: ${ssePath}`);
    log(`Message endpoint: ${messagePath}`);
    log(`Health endpoint: ${healthPath}`);
  });

  process.on("SIGINT", () => {
    log("Shutting down...");
    for (const session of sessions.values()) {
      session.response.end();
    }
    sessions.clear();
    childManager.kill();
    server.close();
    process.exit(0);
  });
}

function setupChildStdoutBroadcast(
  child: ManagedChildProcess,
  sessions: Map<string, SseSession>,
  log: (msg: string) => void
): void {
  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as JSONRPCMessage;
      log(`Server -> Clients (${sessions.size}): ${line}`);

      for (const session of sessions.values()) {
        session.transport.send(message).catch((err) => {
          log(`[${session.id}] Failed to send: ${err}`);
        });
      }
    } catch {
      log(`Non-JSON from child: ${line}`);
    }
  });
}
