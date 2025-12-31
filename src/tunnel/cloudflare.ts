import type { TunnelInfo, TunnelProviderHandler } from "./providers.js";
import { spawnProcess, type CompatSubprocess } from "../compat/index.js";

/**
 * Cloudflare Tunnel provider using cloudflared.
 */
export class CloudflareTunnelProvider implements TunnelProviderHandler {
  name = "cloudflare" as const;
  displayName = "Cloudflare Tunnel";
  private process: CompatSubprocess | null = null;

  async start(port: number): Promise<TunnelInfo> {
    // Check if cloudflared is installed
    const which = spawnProcess(["which", "cloudflared"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const whichResult = await which.exited;

    if (whichResult !== 0) {
      throw new Error(
        "cloudflared not found. Install with:\n" +
          "  macOS: brew install cloudflared\n" +
          "  Linux: See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/",
      );
    }

    // Start cloudflared tunnel
    this.process = spawnProcess(["cloudflared", "tunnel", "--url", `http://localhost:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Parse output to find tunnel URL
    const url = await this.parseCloudflaredOutput();

    return { provider: this.name, url, process: this.process };
  }

  private async parseCloudflaredOutput(): Promise<string> {
    if (!this.process) throw new Error("Process not started");

    const stderr = this.process.stderr;
    if (!stderr) {
      throw new Error("Could not read cloudflared output");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    const timeoutMs = 30000; // 30 second timeout
    const startTime = Date.now();

    try {
      for await (const chunk of stderr) {
        if (Date.now() - startTime >= timeoutMs) break;

        buffer += decoder.decode(chunk, { stream: true });
        const match = buffer.match(urlRegex);

        if (match) {
          return match[0];
        }
      }
    } catch {
      // Ignore read errors
    }

    throw new Error(
      "Could not parse tunnel URL from cloudflared output. Make sure cloudflared is working correctly.",
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
