import type { CompatSubprocess } from "../compat/index.js";

/**
 * Available tunnel provider types.
 */
export type TunnelProvider = "cloudflare" | "ngrok" | "routermcp-cloud";

/**
 * Information about an active tunnel.
 */
export interface TunnelInfo {
  provider: TunnelProvider;
  url: string;
  process?: CompatSubprocess;
}

/**
 * Interface for tunnel provider implementations.
 */
export interface TunnelProviderHandler {
  name: TunnelProvider;
  displayName: string;
  start(port: number): Promise<TunnelInfo>;
  stop(): Promise<void>;
}
