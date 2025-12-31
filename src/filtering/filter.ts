import micromatch from "micromatch";
import type { FilterConfig } from "../config/types.js";

/**
 * Check if an item should be allowed based on filter configuration.
 *
 * Filter logic (order of precedence):
 * 1. If deny list contains exact match -> DENY
 * 2. If deny glob matches -> DENY
 * 3. If allow list is defined and contains exact match -> ALLOW
 * 4. If allow glob is defined and matches -> ALLOW
 * 5. If no allow rules defined -> ALLOW (default permit)
 * 6. Otherwise -> DENY
 */
export function shouldAllow(name: string, filter: FilterConfig): boolean {
  // Check deny rules first (highest precedence)
  if (filter.deny?.includes(name)) {
    return false;
  }

  if (filter.denyGlob && filter.denyGlob.length > 0) {
    if (micromatch.isMatch(name, filter.denyGlob)) {
      return false;
    }
  }

  // Check if any allow rules are defined
  const hasAllowRules =
    (filter.allowed && filter.allowed.length > 0) ||
    (filter.allowedGlob && filter.allowedGlob.length > 0);

  // If no allow rules, default to allow
  if (!hasAllowRules) {
    return true;
  }

  // Check allow rules
  if (filter.allowed?.includes(name)) {
    return true;
  }

  if (filter.allowedGlob && filter.allowedGlob.length > 0) {
    if (micromatch.isMatch(name, filter.allowedGlob)) {
      return true;
    }
  }

  // Has allow rules but didn't match any -> deny
  return false;
}

/**
 * Extract tool filter config from server config.
 */
export function getToolFilter(serverConfig: {
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
 * Extract resource filter config from server config.
 */
export function getResourceFilter(serverConfig: {
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
 * Extract prompt filter config from server config.
 */
export function getPromptFilter(serverConfig: {
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
 * Filter an array of items based on filter configuration.
 */
export function filterItems<T extends { name: string }>(items: T[], filter: FilterConfig): T[] {
  return items.filter((item) => shouldAllow(item.name, filter));
}
