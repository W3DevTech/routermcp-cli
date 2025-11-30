import * as p from "@clack/prompts";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, RouterMcpConfig } from "../config/types.js";
import { findConfigFile, loadConfig } from "../config/loader.js";
import { createClientTransport } from "../transports/index.js";
import { file, write } from "../compat/index.js";

type MigrationClient = "cursor" | "claude-code";

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
      { value: "migrate" as const, label: "Migrate existing MCP Config (Cursor/Claude Code)" },
      ...(serverCount > 0 ? [{ value: "edit" as const, label: "Edit an existing server" }] : []),
      ...(serverCount > 0 ? [{ value: "remove" as const, label: "Remove a server" }] : []),
      { value: "list" as const, label: "List all servers" },
      { value: "validate-save" as const, label: "Validate, Save and exit" },
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
      case "migrate":
        await migrateFromClient(config);
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
      case "validate-save":
        if (await validateAndSaveConfig(config)) {
          done = true;
        }
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
    await write(path, content);
    p.log.success(`Saved config to: ${path}`);
  } catch (err) {
    p.log.error(`Failed to save config: ${err}`);
  }
}

/**
 * Validate a single server by connecting to it.
 */
async function validateServer(
  serverName: string,
  serverConfig: ServerConfig
): Promise<{ success: boolean; toolCount?: number; error?: string }> {
  try {
    const { client, cleanup } = await createClientTransport(serverName, serverConfig);
    const result = await client.listTools();
    const toolCount = result.tools?.length || 0;
    await cleanup();
    return { success: true, toolCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Validate all servers and save if successful.
 * Returns true if save was completed, false otherwise.
 */
async function validateAndSaveConfig(config: RouterMcpConfig): Promise<boolean> {
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    p.log.warn("No servers to validate");
    await saveConfig(config);
    return true;
  }

  p.log.info(`Validating ${servers.length} server(s)...`);

  const results: Array<{
    name: string;
    success: boolean;
    toolCount?: number;
    error?: string;
  }> = [];

  // Validate each server
  for (const [name, serverConfig] of servers) {
    const spinner = p.spinner();
    spinner.start(`Validating ${name}...`);

    const result = await validateServer(name, serverConfig);
    results.push({ name, ...result });

    if (result.success) {
      spinner.stop(`${name}: OK (${result.toolCount} tools)`);
    } else {
      spinner.stop(`${name}: FAILED`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  p.log.info(`\nValidation results: ${passed.length} passed, ${failed.length} failed`);

  if (failed.length > 0) {
    p.log.error("Failed servers:");
    for (const f of failed) {
      p.log.message(`  ${f.name}: ${f.error}`);
    }

    const saveAnyway = await p.confirm({
      message: "Some servers failed validation. Save config anyway?",
      initialValue: false,
    });

    if (p.isCancel(saveAnyway) || !saveAnyway) {
      p.log.info("Config not saved");
      return false;
    }
  }

  await saveConfig(config);
  return true;
}

/**
 * Get the config file path for an MCP client.
 */
function getMcpClientConfigPath(client: MigrationClient): string {
  const cwd = process.cwd();
  switch (client) {
    case "cursor":
      return `${cwd}/.cursor/mcp.json`;
    case "claude-code":
      return `${cwd}/.mcp.json`;
  }
}

/**
 * Get a human-readable label for an MCP client.
 */
function getClientLabel(client: MigrationClient): string {
  switch (client) {
    case "cursor":
      return "Cursor IDE";
    case "claude-code":
      return "Claude Code";
  }
}

/**
 * Read and parse a client's MCP config file.
 */
async function readClientConfig(path: string): Promise<RouterMcpConfig | null> {
  try {
    const f = file(path);
    if (!(await f.exists())) {
      return null;
    }
    const content = await f.text();
    const parsed = parseJsonc(content);

    // Validate structure
    if (!parsed || typeof parsed !== "object" || !parsed.mcpServers) {
      return null;
    }

    return parsed as RouterMcpConfig;
  } catch {
    return null;
  }
}

/**
 * Merge servers from source config into target config.
 * Handles name collisions by prompting user.
 */
async function mergeServerConfigs(
  target: RouterMcpConfig,
  source: RouterMcpConfig
): Promise<number> {
  let mergedCount = 0;

  for (const [name, serverConfig] of Object.entries(source.mcpServers)) {
    // Check for collision
    if (target.mcpServers[name]) {
      const action = await p.select({
        message: `Server "${name}" already exists. What would you like to do?`,
        options: [
          { value: "skip", label: "Skip this server" },
          { value: "rename", label: "Rename and add" },
          { value: "replace", label: "Replace existing" },
        ],
      });

      if (p.isCancel(action) || action === "skip") {
        continue;
      }

      if (action === "rename") {
        const newName = await p.text({
          message: "Enter new name for this server:",
          placeholder: `${name}-imported`,
          validate: (value) => {
            if (!value) return "Name is required";
            if (target.mcpServers[value]) return "Server with this name already exists";
            if (!/^[a-zA-Z0-9-_]+$/.test(value))
              return "Name must be alphanumeric with hyphens/underscores";
            return undefined;
          },
        });

        if (p.isCancel(newName)) continue;

        target.mcpServers[newName as string] = serverConfig;
        mergedCount++;
      } else {
        // Replace
        target.mcpServers[name] = serverConfig;
        mergedCount++;
      }
    } else {
      target.mcpServers[name] = serverConfig;
      mergedCount++;
    }
  }

  return mergedCount;
}

/**
 * Replace a client's MCP config with routermcp proxy.
 */
async function replaceClientConfig(client: MigrationClient): Promise<void> {
  const configPath = getMcpClientConfigPath(client);
  const routermcpConfig = {
    mcpServers: {
      routermcp: {
        command: "bunx",
        args: ["-y", "routermcp"]
      }
    }
  };

  try {
    await write(configPath, JSON.stringify(routermcpConfig, null, 2));
    p.log.success(`Replaced ${getClientLabel(client)} config with routermcp proxy`);
  } catch (err) {
    p.log.error(`Failed to replace config: ${err}`);
  }
}

/**
 * Migrate servers from an MCP client config.
 */
async function migrateFromClient(config: RouterMcpConfig): Promise<void> {
  // 1. Select client
  const client = await p.select({
    message: "Select MCP client to migrate from:",
    options: [
      { value: "cursor" as const, label: "Cursor IDE (.cursor/mcp.json)" },
      { value: "claude-code" as const, label: "Claude Code (.mcp.json)" },
    ],
  });

  if (p.isCancel(client)) return;

  const clientLabel = getClientLabel(client);
  const configPath = getMcpClientConfigPath(client);

  // 2. Read and parse config
  const spinner = p.spinner();
  spinner.start(`Reading ${clientLabel} config...`);

  const clientConfig = await readClientConfig(configPath);

  if (!clientConfig) {
    spinner.stop(`Config not found or invalid`);
    p.log.error(`Could not find or parse ${clientLabel} config at: ${configPath}`);
    return;
  }

  const serverCount = Object.keys(clientConfig.mcpServers).length;
  spinner.stop(`Found ${serverCount} servers in ${clientLabel} config`);

  if (serverCount === 0) {
    p.log.warn("No servers to migrate");
    return;
  }

  // 3. List servers to migrate
  p.log.info("Servers to migrate:");
  for (const [name, server] of Object.entries(clientConfig.mcpServers)) {
    const details = server.command
      ? `command: ${server.command}`
      : server.url
        ? `url: ${server.url}`
        : "unknown";
    p.log.message(`  ${name} - ${details}`);
  }

  // 4. Confirm migration
  const confirmMigrate = await p.confirm({
    message: `Migrate ${serverCount} servers from ${clientLabel}?`,
    initialValue: true,
  });

  if (p.isCancel(confirmMigrate) || !confirmMigrate) return;

  // 5. Merge servers
  const mergedCount = await mergeServerConfigs(config, clientConfig);
  p.log.success(`Migrated ${mergedCount} servers`);

  // 6. Ask about replacement
  const shouldReplace = await p.confirm({
    message: `Replace ${clientLabel}'s config with routermcp proxy?\nThis will replace all servers with a single routermcp entry.`,
    initialValue: false,
  });

  if (p.isCancel(shouldReplace)) return;

  if (shouldReplace) {
    await replaceClientConfig(client);
  }
}
