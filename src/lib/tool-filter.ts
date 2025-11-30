import { minimatch } from "minimatch";
import type { McpServerToolFilter, ToolInfo } from "../types.ts";

/**
 * Check if a tool name matches any of the glob patterns
 */
function matchesAnyGlob(toolName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(toolName, pattern));
}

/**
 * Filter tools based on allow/deny rules and glob patterns
 *
 * Filter logic:
 * 1. If allowedTools is set and non-empty, only those tools are allowed (explicit allow)
 * 2. If allowedToolsGlob is set, tools matching those patterns are allowed
 * 3. If denyTools is set, those tools are denied (explicit deny)
 * 4. If denyToolsGlob is set, tools matching those patterns are denied
 * 5. Deny rules take precedence over allow rules
 * 6. If no allow rules are specified, all tools are allowed by default (minus denies)
 *
 * @param tools List of tools to filter
 * @param filter Tool filter configuration
 * @returns Filtered list of tools
 */
export function filterTools(
  tools: ToolInfo[],
  filter: McpServerToolFilter
): ToolInfo[] {
  const {
    allowedTools = [],
    denyTools = [],
    allowedToolsGlob = [],
    denyToolsGlob = [],
  } = filter;

  const hasAllowRules = allowedTools.length > 0 || allowedToolsGlob.length > 0;

  return tools.filter((tool) => {
    const toolName = tool.name;

    // Check deny rules first (they take precedence)
    if (denyTools.includes(toolName)) {
      return false;
    }
    if (denyToolsGlob.length > 0 && matchesAnyGlob(toolName, denyToolsGlob)) {
      return false;
    }

    // If no allow rules, allow all (minus denies which are already handled)
    if (!hasAllowRules) {
      return true;
    }

    // Check allow rules
    if (allowedTools.includes(toolName)) {
      return true;
    }
    if (allowedToolsGlob.length > 0 && matchesAnyGlob(toolName, allowedToolsGlob)) {
      return true;
    }

    // Has allow rules but tool doesn't match any
    return false;
  });
}
