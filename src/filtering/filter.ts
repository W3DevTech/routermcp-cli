/**
 * Filtering logic for tools, resources, and prompts
 */

import micromatch from "micromatch";
import type { FilterConfig } from "../config/types.js";

/**
 * Filter logic:
 * 1. If denyList contains exact match → DENY
 * 2. If denyGlob matches → DENY
 * 3. If allowList defined and contains match → ALLOW
 * 4. If allowGlob defined and matches → ALLOW
 * 5. If no allow rules defined → ALLOW (default permit)
 * 6. Otherwise → DENY
 *
 * @param name The name to check
 * @param config Filter configuration
 * @returns true if allowed, false if denied
 */
export function isAllowed(name: string, config: FilterConfig): boolean {
  // Step 1: Check deny list
  if (config.deny?.includes(name)) {
    return false;
  }

  // Step 2: Check deny glob patterns
  if (config.denyGlob && config.denyGlob.length > 0) {
    if (micromatch.isMatch(name, config.denyGlob)) {
      return false;
    }
  }

  // Check if any allow rules are defined
  const hasAllowRules =
    (config.allowed && config.allowed.length > 0) ||
    (config.allowedGlob && config.allowedGlob.length > 0);

  // Step 5: If no allow rules defined, default permit
  if (!hasAllowRules) {
    return true;
  }

  // Step 3: Check allow list
  if (config.allowed?.includes(name)) {
    return true;
  }

  // Step 4: Check allow glob patterns
  if (config.allowedGlob && config.allowedGlob.length > 0) {
    if (micromatch.isMatch(name, config.allowedGlob)) {
      return true;
    }
  }

  // Step 6: If allow rules exist but none matched, deny
  return false;
}

/**
 * Create a FilterConfig from server configuration for tools
 */
export function getToolFilterConfig(serverConfig: {
  allowedTools?: string[];
  denyTools?: string[];
  allowedToolsGlob?: string[];
  denyToolsGlob?: string[];
}): FilterConfig {
  return {
    allowed: serverConfig.allowedTools,
    deny: serverConfig.denyTools,
    allowedGlob: serverConfig.allowedToolsGlob,
    denyGlob: serverConfig.denyToolsGlob,
  };
}

/**
 * Create a FilterConfig from server configuration for resources
 */
export function getResourceFilterConfig(serverConfig: {
  allowedResources?: string[];
  denyResources?: string[];
  allowedResourcesGlob?: string[];
  denyResourcesGlob?: string[];
}): FilterConfig {
  return {
    allowed: serverConfig.allowedResources,
    deny: serverConfig.denyResources,
    allowedGlob: serverConfig.allowedResourcesGlob,
    denyGlob: serverConfig.denyResourcesGlob,
  };
}

/**
 * Create a FilterConfig from server configuration for prompts
 */
export function getPromptFilterConfig(serverConfig: {
  allowedPrompts?: string[];
  denyPrompts?: string[];
  allowedPromptsGlob?: string[];
  denyPromptsGlob?: string[];
}): FilterConfig {
  return {
    allowed: serverConfig.allowedPrompts,
    deny: serverConfig.denyPrompts,
    allowedGlob: serverConfig.allowedPromptsGlob,
    denyGlob: serverConfig.denyPromptsGlob,
  };
}

/**
 * Filter an array of items based on filter config
 */
export function filterItems<T extends { name: string }>(
  items: T[],
  config: FilterConfig,
): T[] {
  return items.filter((item) => isAllowed(item.name, config));
}
