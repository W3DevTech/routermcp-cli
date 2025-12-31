#!/usr/bin/env bun

// Force ASCII mode in Bun to work around Unicode rendering issues
// in @clack/prompts. Can be overridden with FORCE_UNICODE=1.
// See: https://github.com/oven-sh/bun/issues/4835
if (typeof globalThis.Bun !== "undefined" && !process.env.FORCE_UNICODE) {
  process.env.TERM = "linux";
}

import { ensureWebCrypto } from "./oauth/crypto-polyfill.js";
ensureWebCrypto();

// Dynamic import to ensure TERM is set before @clack/prompts loads
const { main, getCurrentCommand, getCurrentArgs } = await import("./cli/index.js");
const { reportError } = await import("./telemetry/index.js");

// Remove "bun" and script path from args
const args = process.argv.slice(2);

main(args).catch(async (err) => {
  const command = getCurrentCommand();
  const cliArgs = getCurrentArgs();
  await reportError(err, { command, args: cliArgs });

  console.error("Fatal error:", err);
  process.exit(1);
});
