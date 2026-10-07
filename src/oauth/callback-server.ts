import { type ServerHandle, serve } from "../compat/index.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

export interface OAuthCallbackServer {
  readonly port: number;
  readonly callbackUrl: string;
  start(): Promise<void>;
  waitForCallback(timeoutMs?: number): Promise<OAuthCallbackResult>;
  stop(): Promise<void>;
}

function buildSuccessHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #22c55e; margin-bottom: 16px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this tab and return to the terminal.</p>
  </div>
</body>
</html>`;
}

function buildErrorHtml(error: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: #666; }
    .error { color: #ef4444; font-family: monospace; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <p class="error">${error}</p>
  </div>
</body>
</html>`;
}

export async function createOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  let httpServer: ServerHandle | null = null;
  let boundPort: number | null = null;
  let pendingResolve: ((result: OAuthCallbackResult) => void) | null = null;
  let pendingReject: ((error: Error) => void) | null = null;

  const server: OAuthCallbackServer = {
    get port(): number {
      return boundPort ?? 0;
    },

    get callbackUrl(): string {
      return boundPort === null
        ? "http://127.0.0.1/oauth/callback"
        : `http://127.0.0.1:${boundPort}/oauth/callback`;
    },

    async start(): Promise<void> {
      if (httpServer) return;

      const listener = serve({
        port: 0,
        host: "127.0.0.1",
        fetch: async (request: Request): Promise<Response> => {
          const url = new URL(request.url);

          if (url.pathname !== "/oauth/callback") {
            return new Response("Not Found", { status: 404 });
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const errorDescription = url.searchParams.get("error_description");

          if (error) {
            const errorMsg = errorDescription || error;
            if (pendingReject) {
              pendingReject(new Error(`OAuth error: ${errorMsg}`));
              pendingResolve = null;
              pendingReject = null;
            }
            return new Response(buildErrorHtml(errorMsg), {
              status: 200,
              headers: { "Content-Type": "text/html" },
            });
          }

          if (!code) {
            const errorMsg = "Missing authorization code";
            if (pendingReject) {
              pendingReject(new Error(errorMsg));
              pendingResolve = null;
              pendingReject = null;
            }
            return new Response(buildErrorHtml(errorMsg), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          if (pendingResolve) {
            pendingResolve({ code, state: state || undefined });
            pendingResolve = null;
            pendingReject = null;
          }

          return new Response(buildSuccessHtml(), {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        },
      });

      httpServer = listener;
      try {
        boundPort = listener.ready ? await listener.ready : listener.port;
        if (boundPort < 1 || boundPort > 65535) {
          throw new Error("Callback server did not report a valid ephemeral port");
        }
      } catch (error) {
        listener.stop();
        httpServer = null;
        boundPort = null;
        throw error;
      }
    },

    async waitForCallback(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<OAuthCallbackResult> {
      return new Promise((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;

        const timeout = setTimeout(() => {
          if (pendingReject) {
            pendingReject(new Error("Authorization timed out"));
            pendingResolve = null;
            pendingReject = null;
          }
        }, timeoutMs);

        const originalResolve = pendingResolve;
        const originalReject = pendingReject;

        pendingResolve = (result) => {
          clearTimeout(timeout);
          originalResolve(result);
        };

        pendingReject = (error) => {
          clearTimeout(timeout);
          originalReject(error);
        };
      });
    },

    async stop(): Promise<void> {
      if (httpServer) {
        httpServer.stop();
        httpServer = null;
      }
      pendingResolve = null;
      pendingReject = null;
    },
  };

  return server;
}
