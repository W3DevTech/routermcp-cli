#!/usr/bin/env bun
/**
 * RouterMCP CLI Entry Point
 *
 * A Bun-based CLI MCP Gateway that aggregates multiple upstream MCP servers
 * into a single unified interface with tool/resource/prompt filtering.
 */

import { run } from "./cli/index.js";

run().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
