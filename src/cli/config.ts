import * as p from "@clack/prompts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, RouterMcpConfig } from "../config/types.js";
import { findConfigFile, loadConfig } from "../config/loader.js";
import { createClientTransport } from "../transports/index.js";

/**
 * Run the interactive config wizard.
 */
export async function configCommand(): Promise<void> {
  p.intro("RouterMCP Configuration Wizard");

  // Check for existing config
  const existingPath = await findConfigFile(process.cwd());
  let config: RouterMcpConfig = { mcpServers: {} };

  if (existingPath) {
    const useExisting = await p.confirm({
      message: `Found existing config at ${existingPath}. Load it?`,
      initialValue: true,
    });

    if (p.isCancel(useExisting)) {
      p.cancel("Configuration cancelled");
      process.exit(0);
    }

    if (useExisting) {
      try {
        config = await loadConfig(existingPath);
        p.log.success(`Loaded ${Object.keys(config.mcpServers).length} servers`);
      } catch (err) {
        p.log.error(`Failed to load config: ${err}`);
      }
    }
  }

  // Main config loop
  let done = false;
  while (!done) {
    const serverCount = Object.keys(config.mcpServers).length;
    const options = [
      { value: "add" as const, label: "Add a new server" },
      ...(serverCount > 0 ? [{ value: "edit" as const, label: "Edit an existing server" }] : []),
      ...(serverCount > 0 ? [{ value: "remove" as const, label: "Remove a server" }] : []),
      { value: "list" as const, label: "List all servers" },
      { value: "save" as const, label: "Save and exit" },
      { value: "exit" as const, label: "Exit without saving" },
    ];

    const action = await p.select({
      message: `What would you like to do? (${serverCount} servers configured)`,
      options,
    });

    if (p.isCancel(action)) {
      p.cancel("Configuration cancelled");
      process.exit(0);
    }

    switch (action) {
      case "add":
        await addServer(config);
        break;
      case "edit":
        await editServer(config);
        break;
      case "remove":
        await removeServer(config);
        break;
      case "list":
        listServers(config);
        break;
      case "save":
        await saveConfig(config);
        done = true;
        break;
      case "exit":
        done = true;
        break;
    }
  }

  p.outro("Done!");
}

/**
 * Fetch tools from a server by connecting to it temporarily.
 */
async function fetchServerTools(serverName: string, serverConfig: ServerConfig): Promise<Tool[]> {
  const spinner = p.spinner();
  spinner.start("Connecting to server...");

  try {
    const { client, cleanup } = await createClientTransport(serverName, serverConfig);

    spinner.message("Fetching tools...");
    const result = await client.listTools();
    const tools = result.tools || [];

    spinner.stop(`Found ${tools.length} tools`);

    await cleanup();
    return tools;
  } catch (err) {
    spinner.stop("Failed to connect");
    throw err;
  }
}

/**
 * Add a new server to the config.
 */
async function addServer(config: RouterMcpConfig): Promise<void> {
  const name = await p.text({
    message: "Server name (unique identifier):",
    placeholder: "my-server",
    validate: (value) => {
      if (!value) return "Name is required";
      if (config.mcpServers[value]) return "Server with this name already exists";
      if (!/^[a-zA-Z0-9-_]+$/.test(value))
        return "Name must be alphanumeric with hyphens/underscores";
      return undefined;
    },
  });

  if (p.isCancel(name)) return;

  const transport = await p.select({
    message: "Transport type:",
    options: [
      { value: "stdio", label: "stdio - Local process" },
      { value: "http-streamable", label: "http-streamable - Remote HTTP server" },
    ],
  });

  if (p.isCancel(transport)) return;

  let serverConfig: ServerConfig;

  if (transport === "stdio") {
    const command = await p.text({
      message: "Command to run:",
      placeholder: "npx -y @modelcontextprotocol/server-filesystem /path",
    });

    if (p.isCancel(command)) return;

    const argsStr = await p.text({
      message: "Arguments (space-separated, optional):",
      placeholder: "arg1 arg2",
      defaultValue: "",
    });

    if (p.isCancel(argsStr)) return;

    const args = argsStr ? argsStr.split(/\s+/).filter(Boolean) : undefined;

    serverConfig = {
      transport: "stdio",
      command: command as string,
      ...(args && args.length > 0 ? { args } : {}),
    };
  } else {
    const url = await p.text({
      message: "Server URL:",
      placeholder: "http://localhost:3000/mcp",
      validate: (value) => {
        try {
          new URL(value);
          return undefined;
        } catch {
          return "Invalid URL";
        }
      },
    });

    if (p.isCancel(url)) return;

    serverConfig = {
      transport: "http-streamable",
      url: url as string,
    };
  }

  // Ask about tool filtering
  const configureFiltering = await p.confirm({
    message: "Configure tool/resource/prompt filtering?",
    initialValue: false,
  });

  if (p.isCancel(configureFiltering)) return;

  if (configureFiltering) {
    await configureServerFiltering(name as string, serverConfig);
  }

  config.mcpServers[name as string] = serverConfig;
  p.log.success(`Added server: ${name}`);
}

/**
 * Configure filtering for a server.
 */
async function configureServerFiltering(serverName: string, config: ServerConfig): Promise<void> {
  // Tool filtering
  const toolFilterType = await p.select({
    message: "Tool filtering mode:",
    options: [
      { value: "none", label: "No filtering (allow all)" },
      { value: "allow", label: "Allow specific tools only" },
      { value: "deny", label: "Deny specific tools" },
    ],
  });

  if (p.isCancel(toolFilterType)) return;

  if (toolFilterType === "allow") {
    await configureAllowedTools(serverName, config);
  } else if (toolFilterType === "deny") {
    await configureDeniedTools(serverName, config);
  }
}

/**
 * Configure allowed tools - either manually or by selecting from server.
 */
async function configureAllowedTools(serverName: string, config: ServerConfig): Promise<void> {
  const inputMethod = await p.select({
    message: "How would you like to specify allowed tools?",
    options: [
      { value: "select", label: "Select from server tools (connects to server)" },
      { value: "manual", label: "Enter manually (supports glob patterns)" },
    ],
  });

  if (p.isCancel(inputMethod)) return;

  if (inputMethod === "select") {
    // Connect to server and fetch tools
    let tools: Tool[];
    try {
      tools = await fetchServerTools(serverName, config);
    } catch (err) {
      p.log.error(`Failed to fetch tools: ${err}`);
      p.log.info("Falling back to manual entry...");
      await manualAllowedToolsEntry(config);
      return;
    }

    if (tools.length === 0) {
      p.log.warn("Server has no tools. Skipping tool filtering.");
      return;
    }

    // Show multi-select for tools
    const selectedTools = await p.multiselect({
      message: "Select tools to allow:",
      options: tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
        hint: tool.description ? truncate(tool.description, 50) : undefined,
      })),
      required: false,
    });

    if (p.isCancel(selectedTools)) return;

    if (selectedTools.length > 0) {
      config.allowedTools = selectedTools as string[];
    }
  } else {
    await manualAllowedToolsEntry(config);
  }
}

/**
 * Manual entry for allowed tools.
 */
async function manualAllowedToolsEntry(config: ServerConfig): Promise<void> {
  const tools = await p.text({
    message: "Allowed tools (comma-separated, supports globs like 'read_*'):",
    placeholder: "read_file, list_*, search_*",
  });

  if (!p.isCancel(tools) && tools) {
    const patterns = (tools as string).split(",").map((t) => t.trim()).filter(Boolean);
    const exact = patterns.filter((pat) => !pat.includes("*"));
    const globs = patterns.filter((pat) => pat.includes("*"));

    if (exact.length > 0) config.allowedTools = exact;
    if (globs.length > 0) config.allowedToolsGlob = globs;
  }
}

/**
 * Configure denied tools - either manually or by selecting from server.
 */
async function configureDeniedTools(serverName: string, config: ServerConfig): Promise<void> {
  const inputMethod = await p.select({
    message: "How would you like to specify denied tools?",
    options: [
      { value: "select", label: "Select from server tools (connects to server)" },
      { value: "manual", label: "Enter manually (supports glob patterns)" },
    ],
  });

  if (p.isCancel(inputMethod)) return;

  if (inputMethod === "select") {
    // Connect to server and fetch tools
    let tools: Tool[];
    try {
      tools = await fetchServerTools(serverName, config);
    } catch (err) {
      p.log.error(`Failed to fetch tools: ${err}`);
      p.log.info("Falling back to manual entry...");
      await manualDeniedToolsEntry(config);
      return;
    }

    if (tools.length === 0) {
      p.log.warn("Server has no tools. Skipping tool filtering.");
      return;
    }

    // Show multi-select for tools
    const selectedTools = await p.multiselect({
      message: "Select tools to deny:",
      options: tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
        hint: tool.description ? truncate(tool.description, 50) : undefined,
      })),
      required: false,
    });

    if (p.isCancel(selectedTools)) return;

    if (selectedTools.length > 0) {
      config.denyTools = selectedTools as string[];
    }
  } else {
    await manualDeniedToolsEntry(config);
  }
}

/**
 * Manual entry for denied tools.
 */
async function manualDeniedToolsEntry(config: ServerConfig): Promise<void> {
  const tools = await p.text({
    message: "Denied tools (comma-separated, supports globs like 'delete_*'):",
    placeholder: "delete_file, remove_*, *_dangerous",
  });

  if (!p.isCancel(tools) && tools) {
    const patterns = (tools as string).split(",").map((t) => t.trim()).filter(Boolean);
    const exact = patterns.filter((pat) => !pat.includes("*"));
    const globs = patterns.filter((pat) => pat.includes("*"));

    if (exact.length > 0) config.denyTools = exact;
    if (globs.length > 0) config.denyToolsGlob = globs;
  }
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Edit an existing server.
 */
async function editServer(config: RouterMcpConfig): Promise<void> {
  const servers = Object.keys(config.mcpServers);

  const name = await p.select({
    message: "Select server to edit:",
    options: servers.map((s) => ({
      value: s,
      label: `${s} (${config.mcpServers[s].transport})`,
    })),
  });

  if (p.isCancel(name)) return;

  const serverConfig = config.mcpServers[name as string];

  // Edit filtering
  await configureServerFiltering(name as string, serverConfig);
  p.log.success(`Updated server: ${name}`);
}

/**
 * Remove a server from the config.
 */
async function removeServer(config: RouterMcpConfig): Promise<void> {
  const servers = Object.keys(config.mcpServers);

  const name = await p.select({
    message: "Select server to remove:",
    options: servers.map((s) => ({
      value: s,
      label: `${s} (${config.mcpServers[s].transport})`,
    })),
  });

  if (p.isCancel(name)) return;

  const confirm = await p.confirm({
    message: `Are you sure you want to remove "${name}"?`,
    initialValue: false,
  });

  if (p.isCancel(confirm) || !confirm) return;

  delete config.mcpServers[name as string];
  p.log.success(`Removed server: ${name}`);
}

/**
 * List all configured servers.
 */
function listServers(config: RouterMcpConfig): void {
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    p.log.info("No servers configured");
    return;
  }

  p.log.info("Configured servers:");
  for (const [name, server] of servers) {
    const details =
      server.transport === "stdio"
        ? `command: ${server.command}`
        : `url: ${server.url}`;
    p.log.message(`  ${name} (${server.transport}) - ${details}`);

    if (server.allowedTools?.length || server.allowedToolsGlob?.length) {
      p.log.message(`    Allowed tools: ${[...(server.allowedTools || []), ...(server.allowedToolsGlob || [])].join(", ")}`);
    }
    if (server.denyTools?.length || server.denyToolsGlob?.length) {
      p.log.message(`    Denied tools: ${[...(server.denyTools || []), ...(server.denyToolsGlob || [])].join(", ")}`);
    }
  }
}

/**
 * Save the config to a file.
 */
async function saveConfig(config: RouterMcpConfig): Promise<void> {
  const filename = await p.text({
    message: "Save to file:",
    initialValue: "routermcp.jsonc",
  });

  if (p.isCancel(filename)) return;

  const path = `${process.cwd()}/${filename}`;
  const content = JSON.stringify(config, null, 2);

  try {
    await Bun.write(path, content);
    p.log.success(`Saved config to: ${path}`);
  } catch (err) {
    p.log.error(`Failed to save config: ${err}`);
  }
}
