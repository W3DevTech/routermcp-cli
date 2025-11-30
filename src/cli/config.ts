/**
 * Interactive configuration wizard
 */

import * as p from "@clack/prompts";
import { writeFileSync, existsSync } from "fs";
import type { RouterMcpConfig, ServerConfig } from "../config/types.js";

const DEFAULT_CONFIG_PATH = "routermcp.jsonc";

/**
 * Run the interactive configuration wizard
 */
export async function configWizard(): Promise<void> {
  p.intro("RouterMCP Configuration Wizard");

  // Check if config already exists
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const overwrite = await p.confirm({
      message: `${DEFAULT_CONFIG_PATH} already exists. Overwrite?`,
      initialValue: false,
    });

    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Configuration cancelled");
      return;
    }
  }

  const config: RouterMcpConfig = {
    mcpServers: {},
  };

  // Add servers
  let addMore = true;
  while (addMore) {
    const server = await addServerWizard();
    if (server) {
      config.mcpServers[server.name] = server.config;
      p.log.success(`Added server: ${server.name}`);
    }

    const continueAdding = await p.confirm({
      message: "Add another server?",
      initialValue: true,
    });

    if (p.isCancel(continueAdding)) {
      p.cancel("Configuration cancelled");
      return;
    }

    addMore = continueAdding;
  }

  if (Object.keys(config.mcpServers).length === 0) {
    p.log.warn("No servers configured");
    return;
  }

  // Write config file
  const configContent = JSON.stringify(config, null, 2);
  writeFileSync(DEFAULT_CONFIG_PATH, configContent, "utf-8");

  p.outro(`Configuration saved to ${DEFAULT_CONFIG_PATH}`);
}

interface ServerWizardResult {
  name: string;
  config: ServerConfig;
}

async function addServerWizard(): Promise<ServerWizardResult | null> {
  const name = await p.text({
    message: "Server name (unique identifier):",
    placeholder: "my-mcp-server",
    validate: (value) => {
      if (!value.trim()) return "Name is required";
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
        return "Name must contain only letters, numbers, hyphens, and underscores";
      }
      return undefined;
    },
  });

  if (p.isCancel(name)) return null;

  const transport = await p.select({
    message: "Transport type:",
    options: [
      { value: "stdio", label: "Stdio (spawn local process)" },
      { value: "http-streamable", label: "HTTP Streamable (connect to URL)" },
    ],
  });

  if (p.isCancel(transport)) return null;

  let config: ServerConfig;

  if (transport === "stdio") {
    config = await configureStdioServer();
  } else {
    config = await configureHttpServer();
  }

  if (!config) return null;

  return { name: name as string, config };
}

async function configureStdioServer(): Promise<ServerConfig> {
  const command = await p.text({
    message: "Command to run:",
    placeholder: "npx",
    validate: (value) => {
      if (!value.trim()) return "Command is required";
      return undefined;
    },
  });

  if (p.isCancel(command)) {
    return { transport: "stdio" };
  }

  const argsInput = await p.text({
    message: "Command arguments (space-separated):",
    placeholder: "-y @modelcontextprotocol/server-filesystem /home/user",
  });

  if (p.isCancel(argsInput)) {
    return { transport: "stdio", command: command as string };
  }

  const args = argsInput
    ? (argsInput as string)
        .split(/\s+/)
        .filter((arg) => arg.length > 0)
    : undefined;

  return {
    transport: "stdio",
    command: command as string,
    args,
  };
}

async function configureHttpServer(): Promise<ServerConfig> {
  const url = await p.text({
    message: "Server URL:",
    placeholder: "http://localhost:3001/mcp",
    validate: (value) => {
      if (!value.trim()) return "URL is required";
      try {
        new URL(value);
        return undefined;
      } catch {
        return "Invalid URL format";
      }
    },
  });

  if (p.isCancel(url)) {
    return { transport: "http-streamable" };
  }

  const addHeaders = await p.confirm({
    message: "Add custom headers?",
    initialValue: false,
  });

  let headers: Record<string, string> | undefined;

  if (!p.isCancel(addHeaders) && addHeaders) {
    headers = {};

    let addMoreHeaders = true;
    while (addMoreHeaders) {
      const headerName = await p.text({
        message: "Header name:",
        placeholder: "Authorization",
      });

      if (p.isCancel(headerName)) break;

      const headerValue = await p.text({
        message: `Value for ${headerName}:`,
        placeholder: "Bearer ${MY_TOKEN}",
      });

      if (p.isCancel(headerValue)) break;

      headers[headerName as string] = headerValue as string;

      const continueHeaders = await p.confirm({
        message: "Add another header?",
        initialValue: false,
      });

      if (p.isCancel(continueHeaders)) break;
      addMoreHeaders = continueHeaders;
    }

    if (Object.keys(headers).length === 0) {
      headers = undefined;
    }
  }

  return {
    transport: "http-streamable",
    url: url as string,
    headers,
  };
}
