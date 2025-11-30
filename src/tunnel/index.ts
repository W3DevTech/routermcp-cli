import type { TunnelProvider, TunnelProviderHandler } from "./providers.js";
import { CloudflareTunnelProvider } from "./cloudflare.js";
import { NgrokTunnelProvider } from "./ngrok.js";
import { RoutermcpCloudProvider } from "./routermcp-cloud.js";

export * from "./providers.js";

const providers: Record<TunnelProvider, () => TunnelProviderHandler> = {
  cloudflare: () => new CloudflareTunnelProvider(),
  ngrok: () => new NgrokTunnelProvider(),
  "routermcp-cloud": () => new RoutermcpCloudProvider(),
};

/**
 * Get a tunnel provider by name.
 */
export function getTunnelProvider(name: TunnelProvider): TunnelProviderHandler {
  const factory = providers[name];
  if (!factory) {
    throw new Error(`Unknown tunnel provider: ${name}`);
  }
  return factory();
}

/**
 * Get all available tunnel provider names.
 */
export function getAvailableProviders(): TunnelProvider[] {
  return Object.keys(providers) as TunnelProvider[];
}
