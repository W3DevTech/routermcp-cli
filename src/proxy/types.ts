import type { ChildProcess } from "node:child_process";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type OutputTransport = "sse" | "streamableHttp";

export interface ProxyOptions {
  stdioCmd: string;
  port: number;
  outputTransport: OutputTransport;

  basePath: string;
  ssePath: string;
  messagePath: string;
  streamableHttpPath: string;

  stateful: boolean;
  sessionTimeout: number;

  healthEndpoint: string;
  cors: boolean;
  verbose: boolean;

  maxRestarts: number;
}

export interface ProxyOptionsWithDefaults extends ProxyOptions {}

export const DEFAULT_PROXY_OPTIONS: Omit<ProxyOptions, "stdioCmd"> = {
  port: 8000,
  outputTransport: "sse",
  basePath: "",
  ssePath: "/sse",
  messagePath: "/message",
  streamableHttpPath: "/mcp",
  stateful: false,
  sessionTimeout: 60000,
  healthEndpoint: "/health",
  cors: true,
  verbose: false,
  maxRestarts: 3,
};

export interface ManagedChildProcess {
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: () => void;
}

export interface HealthResponse {
  status: "ok" | "error";
  transport: OutputTransport;
  uptime: number;
  sessions?: number;
  childProcess: {
    running: boolean;
    restartCount: number;
  };
}

export type MessageHandler = (message: JSONRPCMessage) => void;

export interface ProxySession {
  id: string;
  transport: unknown;
  child?: ManagedChildProcess;
  messageHandler?: MessageHandler;
  createdAt: number;
}

export interface ProxyServerInfo {
  port: number;
  basePath: string;
  endpoints: {
    sse?: string;
    message?: string;
    streamableHttp?: string;
    health: string;
  };
}
