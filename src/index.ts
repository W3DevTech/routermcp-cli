#!/usr/bin/env bun

// Force ASCII mode in Bun to work around Unicode rendering issues
// in @clack/prompts. Can be overridden with FORCE_UNICODE=1.
// See: https://github.com/oven-sh/bun/issues/4835
if (typeof globalThis.Bun !== "undefined" && !process.env.FORCE_UNICODE) {
  process.env.TERM = "linux";
}

// Dynamic import to ensure TERM is set before @clack/prompts loads
const { main } = await import("./cli/index.js");

// Remove "bun" and script path from args
const args = process.argv.slice(2);

main(args).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Make this file a module for TypeScript
export {};
