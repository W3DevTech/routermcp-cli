import { CloudflareTunnelProvider } from "./cloudflare.js";
import { NgrokTunnelProvider } from "./ngrok.js";
import type { TunnelProvider, TunnelProviderHandler } from "./providers.js";
import { RoutermcpCloudProvider } from "./routermcp-cloud.js";

export * from "./providers.js";

/** Actual tunnel providers (excluding standalone mode) */
type ActualTunnelProvider = Exclude<TunnelProvider, "standalone">;

const providers: Record<ActualTunnelProvider, () => TunnelProviderHandler> = {
  cloudflare: () => new CloudflareTunnelProvider(),
  ngrok: () => new NgrokTunnelProvider(),
  "routermcp-cloud": () => new RoutermcpCloudProvider(),
};

/**
 * Get a tunnel provider by name.
 */
export function getTunnelProvider(name: ActualTunnelProvider): TunnelProviderHandler {
  const factory = providers[name];
  if (!factory) {
    throw new Error(`Unknown tunnel provider: ${name}`);
  }
  return factory();
}

/**
 * Get all available tunnel provider names (excluding standalone).
 */
export function getAvailableProviders(): ActualTunnelProvider[] {
  return Object.keys(providers) as ActualTunnelProvider[];
}
