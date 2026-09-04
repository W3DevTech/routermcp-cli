/**
 * Compatibility layer for Bun APIs when running in Node.js.
 * Provides unified interface that works in both environments.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";

const isBun = typeof globalThis.Bun !== "undefined";

/**
 * File handle compatible with Bun.file() interface.
 */
export interface FileHandle {
  exists(): Promise<boolean>;
  text(): Promise<string>;
}

/**
 * Create a file handle (Bun.file() compatible).
 */
export function file(path: string): FileHandle {
  if (isBun) {
    return (globalThis.Bun as any).file(path);
  }

  return {
    async exists(): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async text(): Promise<string> {
      return readFile(path, "utf-8");
    },
  };
}

/**
 * Write content to a file (Bun.write() compatible).
 */
export async function write(path: string, content: string): Promise<void> {
  if (isBun) {
    await (globalThis.Bun as any).write(path, content);
    return;
  }

  // Ensure directory exists
  const dir = dirname(path);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  await writeFile(path, content, "utf-8");
}

/**
 * Spawn options compatible with Bun.spawn().
 */
export interface CompatSpawnOptions {
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
  stdin?: "pipe" | "inherit" | "ignore";
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Subprocess handle compatible with Bun.spawn() return type.
 */
export interface CompatSubprocess {
  stdout: AsyncIterable<Uint8Array> | null;
  stderr: AsyncIterable<Uint8Array> | null;
  stdin: WritableStream<Uint8Array> | null;
  pid: number;
  exited: Promise<number>;
  kill(): void;
}

/**
 * Spawn a subprocess (Bun.spawn() compatible).
 */
export function spawnProcess(
  command: string[],
  options: CompatSpawnOptions = {},
): CompatSubprocess {
  if (isBun) {
    return (globalThis.Bun as any).spawn(command, options);
  }

  const [cmd, ...args] = command;
  const nodeOptions: SpawnOptions = {
    stdio: [options.stdin ?? "ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    env: options.env ? { ...process.env, ...options.env } : process.env,
    cwd: options.cwd,
  };

  const proc = spawn(cmd, args, nodeOptions);

  // Convert Node.js streams to async iterables
  function streamToAsyncIterable(
    stream: NodeJS.ReadableStream | null,
  ): AsyncIterable<Uint8Array> | null {
    if (!stream) return null;

    return {
      [Symbol.asyncIterator]() {
        const reader = stream[Symbol.asyncIterator] ? stream[Symbol.asyncIterator]() : null;

        if (reader) return reader as AsyncIterator<Uint8Array>;

        // Fallback for streams without async iterator
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            return new Promise((resolve, reject) => {
              const onData = (chunk: Buffer) => {
                stream.removeListener("data", onData);
                stream.removeListener("end", onEnd);
                stream.removeListener("error", onError);
                resolve({ value: new Uint8Array(chunk), done: false });
              };
              const onEnd = () => {
                stream.removeListener("data", onData);
                stream.removeListener("end", onEnd);
                stream.removeListener("error", onError);
                resolve({ value: undefined as any, done: true });
              };
              const onError = (err: Error) => {
                stream.removeListener("data", onData);
                stream.removeListener("end", onEnd);
                stream.removeListener("error", onError);
                reject(err);
              };

              stream.once("data", onData);
              stream.once("end", onEnd);
              stream.once("error", onError);
            });
          },
        };
      },
    };
  }

  const exitedPromise = new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 0));
    proc.on("error", () => resolve(1));
  });

  return {
    stdout: streamToAsyncIterable(proc.stdout),
    stderr: streamToAsyncIterable(proc.stderr),
    stdin: proc.stdin
      ? new WritableStream({
          write(chunk) {
            return new Promise((resolve, reject) => {
              proc.stdin?.write(chunk, (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
          },
          close() {
            proc.stdin?.end();
          },
        })
      : null,
    pid: proc.pid ?? 0,
    exited: exitedPromise,
    kill() {
      proc.kill();
    },
  };
}

/**
 * HTTP server fetch handler type.
 */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * HTTP server options compatible with Bun.serve().
 */
export interface ServeOptions {
  port: number;
  host?: string;
  fetch: FetchHandler;
}

/**
 * HTTP server handle.
 */
export interface ServerHandle {
  stop(): void;
  port: number;
  /** Resolves once the underlying listener is bound, or rejects on bind error. */
  ready?: Promise<number>;
}

/**
 * Start an HTTP server (Bun.serve() compatible).
 */
export function serve(options: ServeOptions): ServerHandle {
  if (isBun) {
    const server = (globalThis.Bun as any).serve({
      port: options.port,
      hostname: options.host,
      fetch: options.fetch,
    });
    const boundPort = server.port ?? options.port;

    // Bun's Server methods may be non-enumerable and may depend on the
    // original receiver. Do not spread the server object: expose an explicit
    // wrapper so lifecycle callers can always invoke stop() safely.
    return {
      port: boundPort,
      ready: Promise.resolve(boundPort),
      stop: () => {
        server.stop();
      },
    };
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Build Request object from Node.js IncomingMessage
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      });

      // Call fetch handler
      const response = await options.fetch(request);

      // Send response
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const responseBody = await response.arrayBuffer();
      res.end(Buffer.from(responseBody));
    } catch (err) {
      console.error("Server error:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  let resolveReady: (port: number) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<number>((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });

  server.once("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      resolveReady(address.port);
    } else {
      rejectReady(new Error("HTTP server did not expose a bound address"));
    }
  });
  server.once("error", (error) => {
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  });
  server.listen(options.port, options.host);

  return {
    stop() {
      server.close();
    },
    port: options.port,
    ready,
  };
}
