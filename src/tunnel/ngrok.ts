import * as p from "@clack/prompts";
import { type CompatSubprocess, spawnProcess } from "../compat/index.js";
import { getCredentialsPath, getNgrokToken, setNgrokToken } from "../utils/credentials.js";
import type { TunnelInfo, TunnelProviderHandler } from "./providers.js";

/**
 * ngrok tunnel provider.
 */
export class NgrokTunnelProvider implements TunnelProviderHandler {
  name = "ngrok" as const;
  displayName = "ngrok";
  private process: CompatSubprocess | null = null;

  async start(port: number): Promise<TunnelInfo> {
    // Check if ngrok is installed
    const which = spawnProcess(["which", "ngrok"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const whichResult = await which.exited;

    if (whichResult !== 0) {
      throw new Error(
        "ngrok not found. Install with:\n" +
          "  macOS: brew install ngrok\n" +
          "  Linux: See https://ngrok.com/download",
      );
    }

    // Check for auth token
    let token = await getNgrokToken();

    if (!token) {
      p.log.warning("ngrok requires an auth token.");
      p.log.info("Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken");

      const inputToken = await p.text({
        message: "Enter your ngrok auth token:",
        validate: (value) => {
          if (!value || value.length < 10) {
            return "Please enter a valid ngrok auth token";
          }
          return undefined;
        },
      });

      if (p.isCancel(inputToken)) {
        throw new Error("ngrok setup cancelled");
      }

      token = inputToken as string;
      await setNgrokToken(token);
      p.log.success(`Token saved to ${getCredentialsPath()}`);
    }

    // Configure ngrok auth
    const authProc = spawnProcess(["ngrok", "config", "add-authtoken", token], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await authProc.exited;

    // Start ngrok tunnel with JSON logging
    this.process = spawnProcess(
      ["ngrok", "http", String(port), "--log", "stdout", "--log-format", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const url = await this.parseNgrokOutput();
    return { provider: this.name, url, process: this.process };
  }

  private async parseNgrokOutput(): Promise<string> {
    if (!this.process) throw new Error("Process not started");

    const stdout = this.process.stdout;
    if (!stdout) {
      throw new Error("Could not read ngrok output");
    }

    const decoder = new TextDecoder();

    const timeoutMs = 30000; // 30 second timeout
    const startTime = Date.now();

    try {
      for await (const chunk of stdout) {
        if (Date.now() - startTime >= timeoutMs) break;

        const lines = decoder.decode(chunk, { stream: true }).split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            // ngrok logs the tunnel URL in a "url" field
            if (data.url?.startsWith("https://")) {
              return data.url;
            }
            // Also check for addr field in start_tunnel message
            if (data.msg === "started tunnel" && data.addr) {
              // Extract the public URL
              const url = data.url || `https://${data.addr}`;
              if (url.startsWith("https://")) {
                return url;
              }
            }
          } catch {
            // Not JSON, ignore
          }
        }
      }
    } catch {
      // Ignore read errors
    }

    throw new Error(
      "Could not parse tunnel URL from ngrok output. Make sure your auth token is valid.",
    );
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      await this.process.exited;
      this.process = null;
    }
  }
}
