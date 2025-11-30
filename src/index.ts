#!/usr/bin/env bun

import { main } from "./cli/index.js";

// Remove "bun" and script path from args
const args = process.argv.slice(2);

main(args).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
