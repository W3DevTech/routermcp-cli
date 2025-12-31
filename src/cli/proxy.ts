import {
  startSseProxy,
  startStreamableHttpProxy,
  DEFAULT_PROXY_OPTIONS,
  type ProxyOptions,
  type OutputTransport,
} from "../proxy/index.js";

export interface ProxyCommandOptions {
  stdio?: string;
  outputTransport?: OutputTransport;
  port?: number;
  basePath?: string;
  ssePath?: string;
  messagePath?: string;
  streamableHttpPath?: string;
  stateful?: boolean;
  sessionTimeout?: number;
  healthEndpoint?: string;
  cors?: boolean;
  noCors?: boolean;
  verbose?: boolean;
  maxRestarts?: number;
}

export async function proxyCommand(options: ProxyCommandOptions): Promise<void> {
  if (!options.stdio) {
    console.error("Error: --stdio is required for proxy command");
    console.error(
      "Example: routermcp proxy --stdio 'npx -y @modelcontextprotocol/server-filesystem .'",
    );
    process.exit(1);
  }

  const corsEnabled = options.noCors ? false : (options.cors ?? DEFAULT_PROXY_OPTIONS.cors);

  const proxyOptions: ProxyOptions = {
    stdioCmd: options.stdio,
    port: options.port ?? DEFAULT_PROXY_OPTIONS.port,
    outputTransport: options.outputTransport ?? DEFAULT_PROXY_OPTIONS.outputTransport,
    basePath: options.basePath ?? DEFAULT_PROXY_OPTIONS.basePath,
    ssePath: options.ssePath ?? DEFAULT_PROXY_OPTIONS.ssePath,
    messagePath: options.messagePath ?? DEFAULT_PROXY_OPTIONS.messagePath,
    streamableHttpPath: options.streamableHttpPath ?? DEFAULT_PROXY_OPTIONS.streamableHttpPath,
    stateful: options.stateful ?? DEFAULT_PROXY_OPTIONS.stateful,
    sessionTimeout: options.sessionTimeout ?? DEFAULT_PROXY_OPTIONS.sessionTimeout,
    healthEndpoint: options.healthEndpoint ?? DEFAULT_PROXY_OPTIONS.healthEndpoint,
    cors: corsEnabled,
    verbose: options.verbose ?? DEFAULT_PROXY_OPTIONS.verbose,
    maxRestarts: options.maxRestarts ?? DEFAULT_PROXY_OPTIONS.maxRestarts,
  };

  if (proxyOptions.verbose) {
    console.error("Proxy configuration:");
    console.error(`  Command: ${proxyOptions.stdioCmd}`);
    console.error(`  Transport: ${proxyOptions.outputTransport}`);
    console.error(`  Port: ${proxyOptions.port}`);
    console.error(`  Base path: ${proxyOptions.basePath || "/"}`);
    if (proxyOptions.outputTransport === "sse") {
      console.error(`  SSE path: ${proxyOptions.ssePath}`);
      console.error(`  Message path: ${proxyOptions.messagePath}`);
    } else {
      console.error(`  MCP path: ${proxyOptions.streamableHttpPath}`);
      console.error(`  Stateful: ${proxyOptions.stateful}`);
      if (proxyOptions.stateful) {
        console.error(`  Session timeout: ${proxyOptions.sessionTimeout}ms`);
      }
    }
    console.error(`  CORS: ${proxyOptions.cors}`);
    console.error(`  Max restarts: ${proxyOptions.maxRestarts}`);
  }

  if (proxyOptions.outputTransport === "sse") {
    await startSseProxy(proxyOptions);
  } else {
    await startStreamableHttpProxy(proxyOptions);
  }
}
