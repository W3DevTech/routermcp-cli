import type { TunnelInfo, TunnelProviderHandler } from "./providers.js";

/**
 * RouterMCP Cloud tunnel provider (Coming Soon).
 */
export class RoutermcpCloudProvider implements TunnelProviderHandler {
  name = "routermcp-cloud" as const;
  displayName = "RouterMCP Cloud";

  async start(_port: number): Promise<TunnelInfo> {
    throw new Error(
      "RouterMCP Cloud is coming soon!\n" +
        "For now, please use --tunnel=cloudflare or --tunnel=ngrok",
    );
  }

  async stop(): Promise<void> {
    // No-op
  }
}
