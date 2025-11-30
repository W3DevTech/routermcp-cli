#!/usr/bin/env bun
import { program } from "commander";
import { startCommand } from "./commands/start.ts";
import { configCommand } from "./commands/config.ts";
import packageJson from "../package.json";

program
  .name("routermcp")
  .description("MCP Gateway CLI - Proxy/aggregate multiple MCP servers into one")
  .version(packageJson.version);

// Default command - start the gateway
program
  .command("start", { isDefault: true })
  .description("Start the MCP gateway server")
  .action(startCommand);

// Config command - interactive configuration
program
  .command("config")
  .description("Interactive configuration editor")
  .action(configCommand);

program.parse();
