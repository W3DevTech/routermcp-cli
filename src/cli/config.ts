import { homedir } from "node:os";
import * as p from "@clack/prompts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseJsonc, modify, applyEdits } from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { file, write } from "../compat/index.js";
import {
  ensureConfigDir,
  getConfigLocations,
  getConfigPathForScope,
  getScopeLabel,
  loadConfig,
} from "../config/loader.js";
import type { ConfigScope, RouterMcpConfig, ServerConfig } from "../config/types.js";
import { getProjectId } from "../daemon/project.js";
import { getToolFilter, shouldAllow } from "../filtering/filter.js";
import { createClientTransport } from "../transports/index.js";

type MigrationClient = "cursor" | "claude-code" | "opencode" | "codex";
type MigrationLevel = "project" | "global";

interface MigrationSource {
  client: MigrationClient;
  level: MigrationLevel;
  path: string;
  label: string;
}

/**
 * Result of parsing an MCP client config file.
 * Distinguishes between parse errors, missing MCP section, and empty MCP section.
 */
type ParseConfigResult =
  | { success: true; config: RouterMcpConfig }
  | { success: false; reason: "invalid-format" | "no-mcp-section" | "empty-mcp" };

/**
 * Information about a detected MCP client.
 */
interface DetectedClient {
  client: MigrationClient;
  level: MigrationLevel;
  path: string;
  exists: boolean;
  hasRoutermcp: boolean;
}

/**
 * Run the interactive config wizard.
 */
export async function configCommand(): Promise<void> {
  // First, select the scope to edit
  const scope = await selectScope();
  if (!scope) return;

  const scopeLabel = getScopeLabel(scope);
  p.intro(`RouterMCP Configuration Wizard [${scopeLabel}]`);

  // Check for existing config at the selected scope
  const configPath = getConfigPathForScope(scope);
  let config: RouterMcpConfig = { mcpServers: {} };
  let existingPath: string | null = null;

  try {
    const f = file(configPath);
    if (await f.exists()) {
      existingPath = configPath;
    }
    // Also check .json variant
    const jsonPath = configPath.replace(/\.jsonc$/, ".json");
    const jsonFile = file(jsonPath);
    if (!existingPath && (await jsonFile.exists())) {
      existingPath = jsonPath;
    }
  } catch {
    // Ignore errors
  }

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

    // Build options based on scope and state
    const options: Array<{ value: string; label: string }> = [
      { value: "add", label: "Add a new server" },
    ];

    // Show "Import from user-global" only for project scopes, and only if user-global exists
    if (scope !== "user-global") {
      const locations = await getConfigLocations();
      const userGlobalLoc = locations.find((l) => l.scope === "user-global");
      if (userGlobalLoc?.exists) {
        options.push({
          value: "import-global",
          label: "Import servers from user-global config",
        });
      }
    }

    // Show migrate option only if migration sources are available for this scope
    const migrationSources = await getAvailableMigrationSources(scope);
    if (migrationSources.length > 0) {
      const clientNames = [...new Set(migrationSources.map((s) => getClientLabel(s.client)))];
      options.push({
        value: "migrate",
        label: `Migrate from existing MCP config (${clientNames.join(", ")})`,
      });
    }

    if (serverCount > 0) {
      options.push({ value: "edit", label: "Edit an existing server" });
      options.push({ value: "remove", label: "Remove a server" });
    }

    options.push(
      { value: "list", label: "List all servers" },
      { value: "list-tools", label: "List and manage tools (connects to servers)" },
      { value: "advanced", label: "Advanced settings" },
    );

    // Show "Config MCP Clients" option for user-global and project-local scopes
    if (scope === "user-global" || scope === "project-local") {
      options.push({ value: "config-clients", label: "Config MCP Clients" });
    }

    options.push(
      { value: "validate-save", label: "Validate, Save and exit" },
      { value: "save", label: "Save and exit" },
      { value: "exit", label: "Exit without saving" },
    );

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
      case "import-global":
        await importFromUserGlobal(config);
        break;
      case "migrate":
        await migrateFromClient(config, scope);
        break;
      case "edit":
        await editServer(config);
        break;
      case "remove":
        await removeServer(config);
        break;
      case "list":
        await listAllServers();
        break;
      case "list-tools":
        await listAndManageTools(config);
        break;
      case "advanced":
        await configureAdvancedSettings(config);
        break;
      case "config-clients":
        await configMcpClients(scope);
        break;
      case "validate-save":
        if (await validateAndSaveConfig(config, scope)) {
          done = true;
        }
        break;
      case "save":
        await saveConfigToScope(config, scope);
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
 * Prompt user to select which config scope to edit.
 */
async function selectScope(): Promise<ConfigScope | null> {
  const locations = await getConfigLocations();

  // Build options with hints about existing configs
  const options = locations.map((loc) => {
    const label = getScopeLabel(loc.scope);
    let hint = "";

    // Truncate path for display
    let displayPath = loc.path;
    if (displayPath.length > 50) {
      displayPath = `...${displayPath.slice(-47)}`;
    }

    if (loc.exists) {
      hint = `${displayPath} (exists)`;
    } else {
      hint = displayPath;
    }

    return {
      value: loc.scope,
      label,
      hint,
    };
  });

  const scope = await p.select({
    message: "Which configuration scope would you like to edit?",
    options,
  });

  if (p.isCancel(scope)) {
    p.cancel("Configuration cancelled");
    process.exit(0);
  }

  return scope as ConfigScope;
}

/**
 * Import servers from user-global config into current config.
 */
async function importFromUserGlobal(config: RouterMcpConfig): Promise<void> {
  const locations = await getConfigLocations();
  const userGlobalLoc = locations.find((l) => l.scope === "user-global");

  if (!userGlobalLoc?.exists) {
    p.log.error("User-global config not found");
    return;
  }

  // Load user-global config
  let globalConfig: RouterMcpConfig;
  try {
    globalConfig = await loadConfig(userGlobalLoc.path);
  } catch (err) {
    p.log.error(`Failed to load user-global config: ${err}`);
    return;
  }

  const globalServers = Object.entries(globalConfig.mcpServers);
  if (globalServers.length === 0) {
    p.log.warn("User-global config has no servers");
    return;
  }

  p.log.info(`User-global config has ${globalServers.length} server(s)`);

  // Show multi-select for servers to import
  const selectedServers = await p.multiselect({
    message: "Select servers to import (deep copy):",
    options: globalServers.map(([name, server]) => {
      const details =
        server.transport === "stdio" ? `command: ${server.command}` : `url: ${server.url}`;
      return {
        value: name,
        label: name,
        hint: `${server.transport} - ${truncate(details, 40)}`,
      };
    }),
    required: false,
  });

  if (p.isCancel(selectedServers) || !Array.isArray(selectedServers) || selectedServers.length === 0) {
    p.log.info("No servers selected");
    return;
  }

  // Import selected servers (deep copy)
  let importedCount = 0;
  for (const name of selectedServers) {
    const serverConfig = globalConfig.mcpServers[name];
    if (!serverConfig) continue;

    // Check for collision
    if (config.mcpServers[name]) {
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
            if (config.mcpServers[value]) return "Server with this name already exists";
            if (!/^[a-zA-Z0-9-_]+$/.test(value))
              return "Name must be alphanumeric with hyphens/underscores";
            return undefined;
          },
        });

        if (p.isCancel(newName)) continue;

        // Deep copy the server config
        config.mcpServers[newName as string] = JSON.parse(JSON.stringify(serverConfig));
        importedCount++;
      } else {
        // Replace - deep copy
        config.mcpServers[name] = JSON.parse(JSON.stringify(serverConfig));
        importedCount++;
      }
    } else {
      // No collision - deep copy
      config.mcpServers[name] = JSON.parse(JSON.stringify(serverConfig));
      importedCount++;
    }
  }

  if (importedCount > 0) {
    p.log.success(`Imported ${importedCount} server(s) from user-global config`);
  }
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
    const patterns = (tools as string)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
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
    const patterns = (tools as string)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
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
  return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Format seconds to human-readable duration.
 * Examples: 30 → "30s", 60 → "1m", 90 → "1m 30s", 180 → "3m"
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Parse human-readable duration to seconds.
 * Accepts: "30s", "2m", "1m30s", "1m 30s", "180" (assumes seconds if no unit)
 * Returns null if invalid.
 */
function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();

  // Pure number - assume seconds
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  // Pattern: optional minutes + optional seconds (e.g., "2m", "30s", "1m30s", "1m 30s")
  const match = trimmed.match(/^(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (!match) {
    return null;
  }

  const minutes = match[1] ? Number.parseInt(match[1], 10) : 0;
  const seconds = match[2] ? Number.parseInt(match[2], 10) : 0;

  if (minutes === 0 && seconds === 0) {
    return null;
  }

  return minutes * 60 + seconds;
}

/**
 * Get current execution mode label.
 * Returns "Code Mode", "MCP Tool Search", or "Standard"
 */
function getExecutionModeLabel(config: RouterMcpConfig): string {
  if (config.codeMode?.enabled) {
    return "Code Mode";
  }
  if (config.mcpToolSearch?.enabled) {
    return "MCP Tool Search";
  }
  return "Standard";
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

  // Show edit menu based on transport type
  let done = false;
  while (!done) {
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (serverConfig.transport === "stdio") {
      options.push({
        value: "command",
        label: "Edit command",
        hint: serverConfig.command,
      });
      options.push({
        value: "args",
        label: "Edit arguments",
        hint: serverConfig.args?.join(" ") || "(none)",
      });
      options.push({
        value: "env",
        label: "Edit environment variables",
        hint: serverConfig.env ? `${Object.keys(serverConfig.env).length} vars` : "(none)",
      });
    } else {
      // HTTP transport
      options.push({
        value: "url",
        label: "Edit URL",
        hint: serverConfig.url,
      });
      options.push({
        value: "headers",
        label: "Edit headers",
        hint: serverConfig.headers ? `${Object.keys(serverConfig.headers).length} headers` : "(none)",
      });
    }

    options.push({
      value: "filtering",
      label: "Configure tool/resource/prompt filtering",
    });
    options.push({
      value: "rename",
      label: "Rename server",
    });
    options.push({
      value: "done",
      label: "Done editing",
    });

    const action = await p.select({
      message: `Editing "${name}" - what would you like to change?`,
      options,
    });

    if (p.isCancel(action)) {
      done = true;
      continue;
    }

    switch (action) {
      case "command": {
        const newCommand = await p.text({
          message: "Command to run:",
          initialValue: serverConfig.command,
        });
        if (!p.isCancel(newCommand) && newCommand) {
          serverConfig.command = newCommand;
          p.log.success("Command updated");
        }
        break;
      }
      case "args": {
        const argsStr = await p.text({
          message: "Arguments (space-separated):",
          initialValue: serverConfig.args?.join(" ") || "",
          placeholder: "arg1 arg2 arg3",
        });
        if (!p.isCancel(argsStr)) {
          const args = argsStr ? argsStr.split(/\s+/).filter(Boolean) : [];
          if (args.length > 0) {
            serverConfig.args = args;
          } else {
            delete serverConfig.args;
          }
          p.log.success("Arguments updated");
        }
        break;
      }
      case "env": {
        await editEnvironmentVariables(serverConfig);
        break;
      }
      case "url": {
        const newUrl = await p.text({
          message: "Server URL:",
          initialValue: serverConfig.url,
          validate: (value) => {
            try {
              new URL(value);
              return undefined;
            } catch {
              return "Invalid URL";
            }
          },
        });
        if (!p.isCancel(newUrl) && newUrl) {
          serverConfig.url = newUrl;
          p.log.success("URL updated");
        }
        break;
      }
      case "headers": {
        await editHeaders(serverConfig);
        break;
      }
      case "filtering": {
        await configureServerFiltering(name as string, serverConfig);
        break;
      }
      case "rename": {
        const newName = await p.text({
          message: "New server name:",
          initialValue: name as string,
          validate: (value) => {
            if (!value) return "Name is required";
            if (value !== name && config.mcpServers[value])
              return "Server with this name already exists";
            if (!/^[a-zA-Z0-9-_]+$/.test(value))
              return "Name must be alphanumeric with hyphens/underscores";
            return undefined;
          },
        });
        if (!p.isCancel(newName) && newName && newName !== name) {
          config.mcpServers[newName] = serverConfig;
          delete config.mcpServers[name as string];
          p.log.success(`Server renamed to: ${newName}`);
          done = true; // Exit since we changed the key
        }
        break;
      }
      case "done": {
        done = true;
        break;
      }
    }
  }

  p.log.success(`Updated server: ${name}`);
}

/**
 * Edit environment variables for a server.
 */
async function editEnvironmentVariables(serverConfig: ServerConfig): Promise<void> {
  let done = false;

  while (!done) {
    const envVars = serverConfig.env || {};
    const envEntries = Object.entries(envVars);

    const options: Array<{ value: string; label: string; hint?: string }> = [
      { value: "add", label: "Add environment variable" },
    ];

    if (envEntries.length > 0) {
      options.push({ value: "edit", label: "Edit existing variable" });
      options.push({ value: "remove", label: "Remove variable" });
    }

    options.push({
      value: "done",
      label: "Done",
      hint: envEntries.length > 0 ? `${envEntries.length} vars configured` : undefined,
    });

    const action = await p.select({
      message: "Environment variables:",
      options,
    });

    if (p.isCancel(action) || action === "done") {
      done = true;
      continue;
    }

    switch (action) {
      case "add": {
        const varName = await p.text({
          message: "Variable name:",
          placeholder: "MY_API_KEY",
          validate: (value) => {
            if (!value) return "Name is required";
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) return "Invalid variable name";
            return undefined;
          },
        });
        if (p.isCancel(varName)) break;

        const varValue = await p.text({
          message: `Value for ${varName}:`,
          placeholder: "value or ${env:OTHER_VAR}",
        });
        if (p.isCancel(varValue)) break;

        if (!serverConfig.env) serverConfig.env = {};
        serverConfig.env[varName as string] = varValue as string;
        p.log.success(`Added ${varName}`);
        break;
      }
      case "edit": {
        const varToEdit = await p.select({
          message: "Select variable to edit:",
          options: envEntries.map(([key, value]) => ({
            value: key,
            label: key,
            hint: truncate(value, 30),
          })),
        });
        if (p.isCancel(varToEdit)) break;

        const newValue = await p.text({
          message: `New value for ${varToEdit}:`,
          initialValue: envVars[varToEdit as string],
        });
        if (!p.isCancel(newValue)) {
          serverConfig.env![varToEdit as string] = newValue as string;
          p.log.success(`Updated ${varToEdit}`);
        }
        break;
      }
      case "remove": {
        const varToRemove = await p.select({
          message: "Select variable to remove:",
          options: envEntries.map(([key, value]) => ({
            value: key,
            label: key,
            hint: truncate(value, 30),
          })),
        });
        if (p.isCancel(varToRemove)) break;

        delete serverConfig.env![varToRemove as string];
        if (Object.keys(serverConfig.env!).length === 0) {
          delete serverConfig.env;
        }
        p.log.success(`Removed ${varToRemove}`);
        break;
      }
    }
  }
}

/**
 * Edit headers for an HTTP server.
 */
async function editHeaders(serverConfig: ServerConfig): Promise<void> {
  let done = false;

  while (!done) {
    const headers = serverConfig.headers || {};
    const headerEntries = Object.entries(headers);

    const options: Array<{ value: string; label: string; hint?: string }> = [
      { value: "add", label: "Add header" },
    ];

    if (headerEntries.length > 0) {
      options.push({ value: "edit", label: "Edit existing header" });
      options.push({ value: "remove", label: "Remove header" });
    }

    options.push({
      value: "done",
      label: "Done",
      hint: headerEntries.length > 0 ? `${headerEntries.length} headers configured` : undefined,
    });

    const action = await p.select({
      message: "HTTP Headers:",
      options,
    });

    if (p.isCancel(action) || action === "done") {
      done = true;
      continue;
    }

    switch (action) {
      case "add": {
        const headerName = await p.text({
          message: "Header name:",
          placeholder: "Authorization",
        });
        if (p.isCancel(headerName)) break;

        const headerValue = await p.text({
          message: `Value for ${headerName}:`,
          placeholder: "Bearer ${env:API_KEY}",
        });
        if (p.isCancel(headerValue)) break;

        if (!serverConfig.headers) serverConfig.headers = {};
        serverConfig.headers[headerName as string] = headerValue as string;
        p.log.success(`Added ${headerName}`);
        break;
      }
      case "edit": {
        const headerToEdit = await p.select({
          message: "Select header to edit:",
          options: headerEntries.map(([key, value]) => ({
            value: key,
            label: key,
            hint: truncate(value, 30),
          })),
        });
        if (p.isCancel(headerToEdit)) break;

        const newValue = await p.text({
          message: `New value for ${headerToEdit}:`,
          initialValue: headers[headerToEdit as string],
        });
        if (!p.isCancel(newValue)) {
          serverConfig.headers![headerToEdit as string] = newValue as string;
          p.log.success(`Updated ${headerToEdit}`);
        }
        break;
      }
      case "remove": {
        const headerToRemove = await p.select({
          message: "Select header to remove:",
          options: headerEntries.map(([key, value]) => ({
            value: key,
            label: key,
            hint: truncate(value, 30),
          })),
        });
        if (p.isCancel(headerToRemove)) break;

        delete serverConfig.headers![headerToRemove as string];
        if (Object.keys(serverConfig.headers!).length === 0) {
          delete serverConfig.headers;
        }
        p.log.success(`Removed ${headerToRemove}`);
        break;
      }
    }
  }
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
 * List all configured servers from all scopes.
 */
async function listAllServers(): Promise<void> {
  const locations = await getConfigLocations();
  let totalServers = 0;

  for (const loc of locations) {
    if (!loc.exists) continue;

    try {
      const scopeConfig = await loadConfig(loc.path);
      const servers = Object.entries(scopeConfig.mcpServers);

      if (servers.length === 0) continue;

      p.log.info(`\n${getScopeLabel(loc.scope)} (${loc.path}):`);

      for (const [name, server] of servers) {
        const details =
          server.transport === "stdio" ? `command: ${server.command}` : `url: ${server.url}`;
        const status = server.enabled === false ? " [disabled]" : "";
        p.log.message(`  ${name} (${server.transport})${status} - ${details}`);

        if (server.allowedTools?.length || server.allowedToolsGlob?.length) {
          p.log.message(
            `    Allowed tools: ${[...(server.allowedTools || []), ...(server.allowedToolsGlob || [])].join(", ")}`,
          );
        }
        if (server.denyTools?.length || server.denyToolsGlob?.length) {
          p.log.message(
            `    Denied tools: ${[...(server.denyTools || []), ...(server.denyToolsGlob || [])].join(", ")}`,
          );
        }
      }

      totalServers += servers.length;

      // Show advanced settings for this scope if any
      const hasAdvancedSettings =
        scopeConfig.codeMode?.enabled ||
        scopeConfig.mcpToolSearch?.enabled ||
        scopeConfig.subprocess_timeout !== undefined ||
        scopeConfig.discovery_concurrency !== undefined ||
        scopeConfig.connection_timeout !== undefined ||
        scopeConfig.strictEnvVars !== undefined;

      if (hasAdvancedSettings) {
        p.log.info("  Advanced Settings:");
        const mode = getExecutionModeLabel(scopeConfig);
        p.log.message(`    Execution mode: ${mode}`);
        if (scopeConfig.subprocess_timeout !== undefined) {
          p.log.message(`    Subprocess timeout: ${formatDuration(scopeConfig.subprocess_timeout)}`);
        }
        if (scopeConfig.discovery_concurrency !== undefined) {
          p.log.message(`    Discovery concurrency: ${scopeConfig.discovery_concurrency}`);
        }
        if (scopeConfig.connection_timeout !== undefined) {
          p.log.message(`    Connection timeout: ${formatDuration(scopeConfig.connection_timeout)}`);
        }
        if (scopeConfig.strictEnvVars !== undefined) {
          p.log.message(`    Strict env vars: ${scopeConfig.strictEnvVars ? "Yes" : "No"}`);
        }
      }
    } catch {
      // Skip scopes with invalid configs
    }
  }

  if (totalServers === 0) {
    p.log.info("No servers configured in any scope");
  }
}

/**
 * List all tools from servers in current config and allow enabling/disabling.
 */
async function listAndManageTools(config: RouterMcpConfig): Promise<void> {
  const servers = Object.entries(config.mcpServers).filter(
    ([_, s]) => s.enabled !== false
  );

  if (servers.length === 0) {
    p.log.info("No enabled servers in current config");
    return;
  }

  const concurrency = config.discovery_concurrency ?? 5;

  interface ServerTools {
    name: string;
    tools: Tool[];
    error?: string;
  }

  const allServerTools: ServerTools[] = [];
  const spinner = p.spinner();
  spinner.start(`Discovering tools from ${servers.length} server(s)...`);

  // Fetch tools in parallel batches
  for (let i = 0; i < servers.length; i += concurrency) {
    const batch = servers.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(async ([name, serverConfig]) => {
        const { client, cleanup } = await createClientTransport(name, serverConfig);
        try {
          const result = await client.listTools();
          return { name, tools: result.tools || [] };
        } finally {
          await cleanup();
        }
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const serverName = batch[j][0];
      if (result.status === "fulfilled") {
        allServerTools.push(result.value);
      } else {
        allServerTools.push({
          name: serverName,
          tools: [],
          error: result.reason?.message || "Connection failed",
        });
      }
    }
  }

  spinner.stop("Discovery complete");

  // Display tools grouped by server
  let totalTools = 0;
  for (const { name: serverName, tools, error } of allServerTools) {
    const serverConfig = config.mcpServers[serverName];
    const filter = getToolFilter(serverConfig);

    if (error) {
      p.log.error(`\n${serverName}: ${error}`);
      continue;
    }

    p.log.info(`\n${serverName} (${tools.length} tools):`);

    if (tools.length === 0) {
      p.log.message("  (no tools)");
      continue;
    }

    for (const tool of tools) {
      const isEnabled = shouldAllow(tool.name, filter);
      const status = isEnabled ? "✓" : "✗";
      const desc = tool.description ? ` - ${truncate(tool.description, 40)}` : "";
      p.log.message(`  ${status} ${tool.name}${desc}`);
    }

    totalTools += tools.length;
  }

  if (totalTools === 0) {
    p.log.info("\nNo tools found across all servers");
    return;
  }

  // Management submenu
  let manageDone = false;
  while (!manageDone) {
    const manageAction = await p.select({
      message: "Manage tools:",
      options: [
        { value: "enable", label: "Enable tools (remove from deny list)" },
        { value: "disable", label: "Disable tools (add to deny list)" },
        { value: "back", label: "Back to main menu" },
      ],
    });

    if (p.isCancel(manageAction) || manageAction === "back") {
      manageDone = true;
      continue;
    }

    // Select server to modify
    const serversWithTools = allServerTools.filter(s => !s.error && s.tools.length > 0);

    if (serversWithTools.length === 0) {
      p.log.warn("No servers with tools available to modify");
      continue;
    }

    const serverToModify = await p.select({
      message: "Select server:",
      options: serversWithTools.map(s => ({
        value: s.name,
        label: `${s.name} (${s.tools.length} tools)`,
      })),
    });

    if (p.isCancel(serverToModify)) continue;

    const selectedServerData = allServerTools.find(s => s.name === serverToModify);
    const serverConfig = config.mcpServers[serverToModify as string];
    const filter = getToolFilter(serverConfig);

    if (manageAction === "enable") {
      // Show currently disabled tools
      const disabledTools = selectedServerData!.tools.filter(
        t => !shouldAllow(t.name, filter)
      );

      if (disabledTools.length === 0) {
        p.log.info("All tools are already enabled for this server");
        continue;
      }

      const toolsToEnable = await p.multiselect({
        message: `Select tools to enable (${disabledTools.length} disabled):`,
        options: disabledTools.map(t => ({
          value: t.name,
          label: t.name,
          hint: t.description ? truncate(t.description, 40) : undefined,
        })),
        required: false,
      });

      if (p.isCancel(toolsToEnable) || toolsToEnable.length === 0) continue;

      // Remove from denyTools
      if (serverConfig.denyTools) {
        serverConfig.denyTools = serverConfig.denyTools.filter(
          t => !(toolsToEnable as string[]).includes(t)
        );
        if (serverConfig.denyTools.length === 0) {
          delete serverConfig.denyTools;
        }
      }

      p.log.success(`Enabled ${toolsToEnable.length} tool(s). Save config to persist changes.`);

    } else if (manageAction === "disable") {
      // Show currently enabled tools
      const enabledTools = selectedServerData!.tools.filter(
        t => shouldAllow(t.name, filter)
      );

      if (enabledTools.length === 0) {
        p.log.info("All tools are already disabled for this server");
        continue;
      }

      const toolsToDisable = await p.multiselect({
        message: `Select tools to disable (${enabledTools.length} enabled):`,
        options: enabledTools.map(t => ({
          value: t.name,
          label: t.name,
          hint: t.description ? truncate(t.description, 40) : undefined,
        })),
        required: false,
      });

      if (p.isCancel(toolsToDisable) || toolsToDisable.length === 0) continue;

      // Add to denyTools
      serverConfig.denyTools = [
        ...(serverConfig.denyTools || []),
        ...(toolsToDisable as string[]),
      ];

      p.log.success(`Disabled ${toolsToDisable.length} tool(s). Save config to persist changes.`);
    }
  }
}

/**
 * Configure advanced settings submenu.
 */
async function configureAdvancedSettings(config: RouterMcpConfig): Promise<void> {
  let done = false;

  while (!done) {
    const currentMode = getExecutionModeLabel(config);
    const subprocessTimeout = config.subprocess_timeout ?? 180;
    const discoveryConcurrency = config.discovery_concurrency ?? 5;
    const connectionTimeout = config.connection_timeout ?? 30;
    const strictEnvVars = config.strictEnvVars ?? false;

    const action = await p.select({
      message: "Advanced Settings",
      options: [
        {
          value: "execution-mode",
          label: "Configure execution mode",
          hint: currentMode,
        },
        {
          value: "subprocess-timeout",
          label: "Subprocess timeout",
          hint: formatDuration(subprocessTimeout),
        },
        {
          value: "discovery-concurrency",
          label: "Discovery concurrency",
          hint: String(discoveryConcurrency),
        },
        {
          value: "connection-timeout",
          label: "Connection timeout",
          hint: formatDuration(connectionTimeout),
        },
        {
          value: "strict-env-vars",
          label: "Strict environment variables",
          hint: strictEnvVars ? "Yes" : "No",
        },
        {
          value: "back",
          label: "Back to main menu",
        },
      ],
    });

    if (p.isCancel(action) || action === "back") {
      done = true;
      continue;
    }

    switch (action) {
      case "execution-mode":
        await configureExecutionMode(config);
        break;
      case "subprocess-timeout":
        await configureSubprocessTimeout(config);
        break;
      case "discovery-concurrency":
        await configureDiscoveryConcurrency(config);
        break;
      case "connection-timeout":
        await configureConnectionTimeout(config);
        break;
      case "strict-env-vars":
        await configureStrictEnvVars(config);
        break;
    }
  }
}

/**
 * Configure execution mode (Standard / Code Mode / Tool Search).
 */
async function configureExecutionMode(config: RouterMcpConfig): Promise<void> {
  const explanation = `
Execution Mode Configuration

RouterMCP supports three execution modes:

• Standard Mode (default)
  All upstream tools are exposed directly to clients. Best for simple
  setups where you want direct access to all tools.

• Code Mode
  Exposes two meta-tools: listTools and executeCode. Allows clients to
  write JavaScript code that orchestrates multiple tool calls in a secure
  QuickJS sandbox. Best for complex workflows requiring programmatic tool
  coordination.

• MCP Tool Search
  Exposes two meta-tools: searchMcpForTask and callTool. Provides
  intelligent tool discovery based on natural language task descriptions.
  Best for setups with many tools where automatic tool selection is preferred.

Note: Code Mode and Tool Search are mutually exclusive.
`;

  p.log.message(explanation);

  const currentMode = getExecutionModeLabel(config);
  p.log.info(`Current mode: ${currentMode}`);

  const mode = await p.select({
    message: "Select execution mode:",
    options: [
      {
        value: "standard",
        label: "Standard",
        hint: "Direct tool access",
      },
      {
        value: "code-mode",
        label: "Code Mode",
        hint: "JavaScript sandbox execution",
      },
      {
        value: "tool-search",
        label: "MCP Tool Search",
        hint: "Intelligent tool discovery",
      },
    ],
  });

  if (p.isCancel(mode)) return;

  const isCodeModeEnabled = config.codeMode?.enabled === true;
  const isToolSearchEnabled = config.mcpToolSearch?.enabled === true;

  switch (mode) {
    case "standard": {
      if (isCodeModeEnabled || isToolSearchEnabled) {
        const currentModeName = isCodeModeEnabled ? "Code Mode" : "Tool Search";
        const confirm = await p.confirm({
          message: `Disable ${currentModeName} and switch to Standard mode?`,
          initialValue: true,
        });
        if (p.isCancel(confirm) || !confirm) return;

        // Disable but preserve settings
        if (isCodeModeEnabled && config.codeMode) {
          config.codeMode.enabled = false;
        }
        if (isToolSearchEnabled && config.mcpToolSearch) {
          config.mcpToolSearch.enabled = false;
        }
        p.log.success("Switched to Standard mode");
      } else {
        p.log.info("Already in Standard mode");
      }
      break;
    }
    case "code-mode": {
      if (isToolSearchEnabled) {
        const confirm = await p.confirm({
          message: "Code Mode and Tool Search are mutually exclusive.\nDisable Tool Search and enable Code Mode?",
          initialValue: true,
        });
        if (p.isCancel(confirm) || !confirm) return;

        // Disable Tool Search (preserve settings)
        if (config.mcpToolSearch) {
          config.mcpToolSearch.enabled = false;
        }
      }

      // Enable Code Mode
      if (!config.codeMode) {
        config.codeMode = { enabled: true };
      } else {
        config.codeMode.enabled = true;
      }
      p.log.success("Code Mode enabled");

      // Enter Code Mode settings
      await configureCodeMode(config);
      break;
    }
    case "tool-search": {
      if (isCodeModeEnabled) {
        const confirm = await p.confirm({
          message: "Code Mode and Tool Search are mutually exclusive.\nDisable Code Mode and enable Tool Search?",
          initialValue: true,
        });
        if (p.isCancel(confirm) || !confirm) return;

        // Disable Code Mode (preserve settings)
        if (config.codeMode) {
          config.codeMode.enabled = false;
        }
      }

      // Enable Tool Search
      if (!config.mcpToolSearch) {
        config.mcpToolSearch = { enabled: true };
      } else {
        config.mcpToolSearch.enabled = true;
      }
      p.log.success("MCP Tool Search enabled");

      // Enter Tool Search settings
      await configureToolSearch(config);
      break;
    }
  }
}

/**
 * Configure Code Mode settings.
 */
async function configureCodeMode(config: RouterMcpConfig): Promise<void> {
  const explanation = `
Code Mode Settings

Code Mode enables JavaScript code execution in a secure QuickJS WASM sandbox.
Clients can write code that orchestrates multiple tool calls programmatically.

Meta-tools exposed:
• routermcp.listTools - Lists all available tools with their schemas
• routermcp.executeCode - Executes JavaScript code in the sandbox
`;

  p.log.message(explanation);

  let done = false;
  while (!done) {
    // Ensure codeMode exists
    if (!config.codeMode) {
      config.codeMode = { enabled: false };
    }

    const isEnabled = config.codeMode.enabled ?? false;
    const timeout = config.codeMode.timeout ?? 30000;
    const allowFetch = config.codeMode.allowFetch ?? true;

    // Show current settings
    p.log.info("Current settings:");
    p.log.message(`  Enabled: ${isEnabled ? "Yes" : "No"}`);
    p.log.message(`  Timeout: ${formatDuration(timeout / 1000)}`);
    p.log.message(`  Allow fetch: ${allowFetch ? "Yes" : "No"}`);

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (isEnabled) {
      options.push({ value: "disable", label: "Disable Code Mode" });
    } else {
      options.push({ value: "enable", label: "Enable Code Mode" });
    }

    options.push(
      {
        value: "timeout",
        label: "Execution timeout",
        hint: formatDuration(timeout / 1000),
      },
      {
        value: "allow-fetch",
        label: "Allow fetch() in sandbox",
        hint: allowFetch ? "Yes" : "No",
      },
      { value: "reset", label: "Reset all to defaults" },
      { value: "back", label: "Back" },
    );

    const action = await p.select({
      message: "Code Mode Settings",
      options,
    });

    if (p.isCancel(action) || action === "back") {
      done = true;
      continue;
    }

    switch (action) {
      case "enable": {
        // Check for Tool Search conflict
        if (config.mcpToolSearch?.enabled) {
          const confirm = await p.confirm({
            message: "Code Mode and Tool Search are mutually exclusive.\nDisable Tool Search and enable Code Mode?",
            initialValue: true,
          });
          if (p.isCancel(confirm) || !confirm) break;
          config.mcpToolSearch.enabled = false;
        }
        config.codeMode.enabled = true;
        p.log.success("Code Mode enabled");
        break;
      }
      case "disable": {
        const confirm = await p.confirm({
          message: "Disable Code Mode?",
          initialValue: true,
        });
        if (!p.isCancel(confirm) && confirm) {
          config.codeMode.enabled = false;
          p.log.success("Code Mode disabled");
        }
        break;
      }
      case "timeout": {
        const input = await p.text({
          message: "Execution timeout (e.g., '30s', '2m'):",
          initialValue: formatDuration(timeout / 1000),
          validate: (value) => {
            const seconds = parseDuration(value);
            if (seconds === null) return "Invalid duration format. Use e.g., '30s', '2m', '1m30s'";
            const ms = seconds * 1000;
            if (ms < 1000) return "Timeout must be at least 1 second";
            if (ms > 120000) return "Timeout must be at most 2 minutes (120s)";
            return undefined;
          },
        });
        if (!p.isCancel(input)) {
          const seconds = parseDuration(input as string);
          if (seconds !== null) {
            config.codeMode.timeout = seconds * 1000;
            p.log.success(`Timeout set to ${formatDuration(seconds)}`);
          }
        }
        break;
      }
      case "allow-fetch": {
        const newValue = await p.confirm({
          message: "Allow fetch() in sandbox?",
          initialValue: allowFetch,
        });
        if (!p.isCancel(newValue)) {
          config.codeMode.allowFetch = newValue;
          p.log.success(`Allow fetch set to ${newValue ? "Yes" : "No"}`);
        }
        break;
      }
      case "reset": {
        const confirm = await p.confirm({
          message: "Reset Code Mode to defaults? This will disable Code Mode and clear all settings.",
          initialValue: false,
        });
        if (!p.isCancel(confirm) && confirm) {
          delete config.codeMode;
          p.log.success("Code Mode reset to defaults");
          done = true;
        }
        break;
      }
    }
  }
}

/**
 * Configure Tool Search settings.
 */
async function configureToolSearch(config: RouterMcpConfig): Promise<void> {
  const explanation = `
MCP Tool Search Settings

Tool Search provides intelligent tool discovery based on task descriptions.
Instead of exposing all tools directly, it allows clients to search for
relevant tools using natural language.

Meta-tools exposed:
• routermcp.searchMcpForTask - Search tools by task description
• routermcp.callTool - Call a discovered tool by name
`;

  p.log.message(explanation);

  let done = false;
  while (!done) {
    // Ensure mcpToolSearch exists
    if (!config.mcpToolSearch) {
      config.mcpToolSearch = { enabled: false };
    }

    const isEnabled = config.mcpToolSearch.enabled ?? false;
    const description = config.mcpToolSearch.description;
    const maxResults = config.mcpToolSearch.maxResults ?? 5;
    const minScore = config.mcpToolSearch.minScore ?? 0;

    // Show current settings
    p.log.info("Current settings:");
    p.log.message(`  Enabled: ${isEnabled ? "Yes" : "No"}`);
    p.log.message(`  Description: ${description ? truncate(description, 40) : "(default)"}`);
    p.log.message(`  Max results: ${maxResults}`);
    p.log.message(`  Min score: ${minScore}`);

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (isEnabled) {
      options.push({ value: "disable", label: "Disable Tool Search" });
    } else {
      options.push({ value: "enable", label: "Enable Tool Search" });
    }

    options.push(
      {
        value: "description",
        label: "Custom description",
        hint: description ? truncate(description, 30) : "(default)",
      },
      {
        value: "max-results",
        label: "Max results",
        hint: String(maxResults),
      },
      {
        value: "min-score",
        label: "Min score threshold",
        hint: String(minScore),
      },
      { value: "reset", label: "Reset all to defaults" },
      { value: "back", label: "Back" },
    );

    const action = await p.select({
      message: "Tool Search Settings",
      options,
    });

    if (p.isCancel(action) || action === "back") {
      done = true;
      continue;
    }

    switch (action) {
      case "enable": {
        // Check for Code Mode conflict
        if (config.codeMode?.enabled) {
          const confirm = await p.confirm({
            message: "Code Mode and Tool Search are mutually exclusive.\nDisable Code Mode and enable Tool Search?",
            initialValue: true,
          });
          if (p.isCancel(confirm) || !confirm) break;
          config.codeMode.enabled = false;
        }
        config.mcpToolSearch.enabled = true;
        p.log.success("Tool Search enabled");
        break;
      }
      case "disable": {
        const confirm = await p.confirm({
          message: "Disable Tool Search?",
          initialValue: true,
        });
        if (!p.isCancel(confirm) && confirm) {
          config.mcpToolSearch.enabled = false;
          p.log.success("Tool Search disabled");
        }
        break;
      }
      case "description": {
        const descAction = await p.select({
          message: "Description:",
          options: [
            { value: "edit", label: "Set custom description" },
            { value: "reset", label: "Reset to default" },
            { value: "cancel", label: "Cancel" },
          ],
        });

        if (p.isCancel(descAction) || descAction === "cancel") break;

        if (descAction === "reset") {
          delete config.mcpToolSearch.description;
          p.log.success("Description reset to default");
        } else {
          const input = await p.text({
            message: "Custom description for searchMcpForTask tool:",
            initialValue: description || "",
            placeholder: "Search for MCP tools matching a task description",
          });
          if (!p.isCancel(input) && input) {
            config.mcpToolSearch.description = input;
            p.log.success("Description updated");
          }
        }
        break;
      }
      case "max-results": {
        const input = await p.text({
          message: "Maximum number of search results (1-50):",
          initialValue: String(maxResults),
          validate: (value) => {
            const num = Number.parseInt(value, 10);
            if (Number.isNaN(num)) return "Must be a number";
            if (num < 1) return "Must be at least 1";
            if (num > 50) return "Must be at most 50";
            return undefined;
          },
        });
        if (!p.isCancel(input)) {
          config.mcpToolSearch.maxResults = Number.parseInt(input as string, 10);
          p.log.success(`Max results set to ${input}`);
        }
        break;
      }
      case "min-score": {
        const input = await p.text({
          message: "Minimum relevance score threshold (0-1):",
          initialValue: String(minScore),
          validate: (value) => {
            const num = Number.parseFloat(value);
            if (Number.isNaN(num)) return "Must be a number";
            if (num < 0) return "Must be at least 0";
            if (num > 1) return "Must be at most 1";
            return undefined;
          },
        });
        if (!p.isCancel(input)) {
          config.mcpToolSearch.minScore = Number.parseFloat(input as string);
          p.log.success(`Min score set to ${input}`);
        }
        break;
      }
      case "reset": {
        const confirm = await p.confirm({
          message: "Reset Tool Search to defaults? This will disable Tool Search and clear all settings.",
          initialValue: false,
        });
        if (!p.isCancel(confirm) && confirm) {
          delete config.mcpToolSearch;
          p.log.success("Tool Search reset to defaults");
          done = true;
        }
        break;
      }
    }
  }
}

/**
 * Configure subprocess timeout.
 */
async function configureSubprocessTimeout(config: RouterMcpConfig): Promise<void> {
  const currentValue = config.subprocess_timeout ?? 180;

  p.log.message(`
Subprocess Timeout

Maximum time to wait for subprocess operations (tool calls, etc.).
`);

  const input = await p.text({
    message: "Enter timeout (e.g., '30s', '3m', '180'):",
    initialValue: formatDuration(currentValue),
    validate: (value) => {
      const seconds = parseDuration(value);
      if (seconds === null) return "Invalid duration format. Use e.g., '30s', '3m', '1m30s'";
      if (seconds < 0) return "Timeout must be non-negative";
      return undefined;
    },
  });

  if (!p.isCancel(input)) {
    const seconds = parseDuration(input as string);
    if (seconds !== null) {
      if (seconds === 180) {
        // Default value - remove from config to keep it clean
        delete config.subprocess_timeout;
        p.log.success("Subprocess timeout reset to default (3m)");
      } else {
        config.subprocess_timeout = seconds;
        p.log.success(`Subprocess timeout set to ${formatDuration(seconds)}`);
      }
    }
  }
}

/**
 * Configure discovery concurrency.
 */
async function configureDiscoveryConcurrency(config: RouterMcpConfig): Promise<void> {
  const currentValue = config.discovery_concurrency ?? 5;

  p.log.message(`
Discovery Concurrency

Number of upstream servers to discover simultaneously during startup.
Higher values speed up startup but use more resources.
`);

  const input = await p.text({
    message: "Enter concurrency (1-50):",
    initialValue: String(currentValue),
    validate: (value) => {
      const num = Number.parseInt(value, 10);
      if (Number.isNaN(num)) return "Must be a number";
      if (num < 1) return "Must be at least 1";
      if (num > 50) return "Must be at most 50";
      return undefined;
    },
  });

  if (!p.isCancel(input)) {
    const value = Number.parseInt(input as string, 10);
    if (value === 5) {
      // Default value - remove from config to keep it clean
      delete config.discovery_concurrency;
      p.log.success("Discovery concurrency reset to default (5)");
    } else {
      config.discovery_concurrency = value;
      p.log.success(`Discovery concurrency set to ${value}`);
    }
  }
}

/**
 * Configure connection timeout.
 */
async function configureConnectionTimeout(config: RouterMcpConfig): Promise<void> {
  const currentValue = config.connection_timeout ?? 30;

  p.log.message(`
Connection Timeout

Maximum time to wait when connecting to an upstream server.
`);

  const input = await p.text({
    message: "Enter timeout (e.g., '10s', '1m', '30'):",
    initialValue: formatDuration(currentValue),
    validate: (value) => {
      const seconds = parseDuration(value);
      if (seconds === null) return "Invalid duration format. Use e.g., '10s', '1m', '30'";
      if (seconds < 1) return "Timeout must be at least 1 second";
      if (seconds > 300) return "Timeout must be at most 5 minutes (300s)";
      return undefined;
    },
  });

  if (!p.isCancel(input)) {
    const seconds = parseDuration(input as string);
    if (seconds !== null) {
      if (seconds === 30) {
        // Default value - remove from config to keep it clean
        delete config.connection_timeout;
        p.log.success("Connection timeout reset to default (30s)");
      } else {
        config.connection_timeout = seconds;
        p.log.success(`Connection timeout set to ${formatDuration(seconds)}`);
      }
    }
  }
}

/**
 * Configure strict environment variables mode.
 */
async function configureStrictEnvVars(config: RouterMcpConfig): Promise<void> {
  const currentValue = config.strictEnvVars ?? false;

  p.log.message(`
Strict Environment Variables

When enabled, RouterMCP will fail with an error if any \${env:VAR} reference
cannot be resolved. When disabled, unresolved references are left unexpanded
with a warning.
`);

  p.log.info(`Currently: ${currentValue ? "Yes" : "No"}`);

  const newValue = await p.confirm({
    message: "Enable strict environment variable mode?",
    initialValue: currentValue,
  });

  if (!p.isCancel(newValue)) {
    if (newValue === false) {
      // Default value - remove from config to keep it clean
      delete config.strictEnvVars;
      p.log.success("Strict env vars disabled (default)");
    } else {
      config.strictEnvVars = newValue;
      p.log.success("Strict env vars enabled");
    }
  }
}

/**
 * Save the config to a file (legacy - prompts for filename).
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
 * Save the config to the appropriate path for the given scope.
 */
async function saveConfigToScope(config: RouterMcpConfig, scope: ConfigScope): Promise<void> {
  // Ensure directory exists (especially important for user-project scope)
  await ensureConfigDir(scope);

  const configPath = getConfigPathForScope(scope);
  const content = JSON.stringify(config, null, 2);

  try {
    await write(configPath, content);
    p.log.success(`Saved config to: ${configPath}`);
  } catch (err) {
    p.log.error(`Failed to save config: ${err}`);
  }
}

/**
 * Validate a single server by connecting to it.
 */
async function validateServer(
  serverName: string,
  serverConfig: ServerConfig,
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
async function validateAndSaveConfig(
  config: RouterMcpConfig,
  scope: ConfigScope,
): Promise<boolean> {
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    p.log.warn("No servers to validate");
    await saveConfigToScope(config, scope);
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

  await saveConfigToScope(config, scope);
  return true;
}

/**
 * Get the config file path for an MCP client at a given level.
 * Returns null if the client doesn't support that level.
 */
function getMcpClientConfigPath(client: MigrationClient, level: MigrationLevel): string | null {
  const cwd = process.cwd();
  const home = homedir();

  switch (client) {
    case "cursor":
      // Cursor has both project and global configs
      return level === "project" ? `${cwd}/.cursor/mcp.json` : `${home}/.cursor/mcp.json`;
    case "claude-code":
      // Claude Code has both project (.mcp.json) and global (~/.claude.json) configs
      return level === "project" ? `${cwd}/.mcp.json` : `${home}/.claude.json`;
    case "opencode":
      // OpenCode has both project and global configs
      return level === "project"
        ? `${cwd}/opencode.json`
        : `${home}/.config/opencode/opencode.json`;
    case "codex":
      // Codex has both project and global configs
      return level === "project" ? `${cwd}/.codex/config.toml` : `${home}/.codex/config.toml`;
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
    case "opencode":
      return "OpenCode";
    case "codex":
      return "OpenAI Codex";
  }
}

/**
 * Check if a client's config has routermcp already configured.
 */
async function checkHasRoutermcp(configPath: string, client: MigrationClient): Promise<boolean> {
  try {
    const f = file(configPath);
    if (!(await f.exists())) return false;

    const content = await f.text();

    if (client === "codex") {
      const parsed = parseToml(content) as Record<string, unknown>;
      const mcpServers = parsed.mcp_servers as Record<string, unknown> | undefined;
      return !!mcpServers?.routermcp;
    } else {
      const parsed = parseJsonc(content) as Record<string, unknown>;
      if (client === "opencode") {
        const mcp = parsed.mcp as Record<string, unknown> | undefined;
        return !!mcp?.routermcp;
      } else {
        const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
        return !!mcpServers?.routermcp;
      }
    }
  } catch {
    return false;
  }
}

/**
 * Detect all MCP clients at a given level (global or project).
 */
async function detectMcpClients(level: MigrationLevel): Promise<DetectedClient[]> {
  const clients: MigrationClient[] = ["cursor", "claude-code", "opencode", "codex"];
  const results: DetectedClient[] = [];

  for (const clientType of clients) {
    const configPath = getMcpClientConfigPath(clientType, level);
    if (!configPath) continue;

    const f = file(configPath);
    const exists = await f.exists();
    const hasRoutermcp = exists ? await checkHasRoutermcp(configPath, clientType) : false;

    results.push({
      client: clientType,
      level,
      path: configPath,
      exists,
      hasRoutermcp,
    });
  }

  return results;
}

/**
 * Get available migration sources based on the target scope.
 * - user-project scope: no migration sources (use import-global instead)
 * - project-local scope: check project-level configs for all 4 clients
 * - user-global scope: check global AND project-level configs for all 4 clients
 */
async function getAvailableMigrationSources(scope: ConfigScope): Promise<MigrationSource[]> {
  const sources: MigrationSource[] = [];

  // user-project scope doesn't support migration (use import-global instead)
  if (scope === "user-project") {
    return sources;
  }

  // Determine which clients and levels to check based on scope
  const clientsToCheck: Array<{ client: MigrationClient; level: MigrationLevel }> =
    scope === "user-global"
      ? [
          // Global scope: check global configs for all clients
          { client: "cursor", level: "global" },
          { client: "claude-code", level: "global" },
          { client: "opencode", level: "global" },
          { client: "codex", level: "global" },
          // Also check project-level configs (user may want to migrate from current project)
          { client: "cursor", level: "project" },
          { client: "claude-code", level: "project" },
          { client: "opencode", level: "project" },
          { client: "codex", level: "project" },
        ]
      : [
          // Project-local scope: check project configs for all clients
          { client: "cursor", level: "project" },
          { client: "claude-code", level: "project" },
          { client: "opencode", level: "project" },
          { client: "codex", level: "project" },
        ];

  // Check each client/level combination
  for (const { client, level } of clientsToCheck) {
    const configPath = getMcpClientConfigPath(client, level);
    if (!configPath) continue;

    try {
      const f = file(configPath);
      if (await f.exists()) {
        sources.push({
          client,
          level,
          path: configPath,
          label: `${getClientLabel(client)} (${level})`,
        });
      }
    } catch {
      // Ignore errors
    }
  }

  return sources;
}

/**
 * Convert OpenCode env syntax {env:VAR} to RouterMCP syntax ${env:VAR}.
 * Also handles {env:VAR:-default} format.
 */
function convertOpenCodeEnvSyntax(value: string): string {
  // Convert {env:VAR} or {env:VAR:-default} to ${env:VAR} or ${env:VAR:-default}
  return value.replace(/\{env:([^}]+)\}/g, "${env:$1}");
}

/**
 * Recursively convert OpenCode env syntax in an object.
 */
function convertOpenCodeEnvInObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return convertOpenCodeEnvSyntax(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => convertOpenCodeEnvInObject(item)) as T;
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertOpenCodeEnvInObject(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Parse OpenCode config format into RouterMCP format.
 *
 * OpenCode format:
 * {
 *   "mcp": {
 *     "server-name": {
 *       "type": "local" | "remote",
 *       "command": ["cmd", "arg1", "arg2"],  // for local
 *       "url": "https://...",                 // for remote
 *       "environment": { "KEY": "{env:VAR}" }
 *     }
 *   }
 * }
 */
function parseOpenCodeConfig(content: string): ParseConfigResult {
  try {
    const parsed = parseJsonc(content);
    if (!parsed || typeof parsed !== "object") {
      return { success: false, reason: "invalid-format" };
    }

    // OpenCode uses "mcp" key instead of "mcpServers"
    const mcpSection = parsed.mcp;
    if (!mcpSection || typeof mcpSection !== "object") {
      return { success: false, reason: "no-mcp-section" };
    }

    const mcpServers: Record<string, ServerConfig> = {};

    for (const [name, server] of Object.entries(mcpSection)) {
      if (!server || typeof server !== "object") continue;

      const serverObj = server as Record<string, unknown>;
      const serverType = serverObj.type as string | undefined;

      if (serverType === "local" || serverType === "stdio" || serverObj.command) {
        // stdio transport
        const commandArray = serverObj.command as string[] | undefined;
        if (!commandArray || !Array.isArray(commandArray) || commandArray.length === 0) {
          continue;
        }

        const [command, ...args] = commandArray;
        const serverConfig: ServerConfig = {
          transport: "stdio",
          command: convertOpenCodeEnvSyntax(command),
        };

        if (args.length > 0) {
          serverConfig.args = args.map((arg) => convertOpenCodeEnvSyntax(arg));
        }

        // Handle environment variables
        const env = serverObj.environment || serverObj.env;
        if (env && typeof env === "object") {
          serverConfig.env = convertOpenCodeEnvInObject(env as Record<string, string>);
        }

        mcpServers[name] = serverConfig;
      } else if (serverType === "remote" || serverType === "http-streamable" || serverObj.url) {
        // HTTP transport
        const url = serverObj.url as string | undefined;
        if (!url) continue;

        const serverConfig: ServerConfig = {
          transport: "http-streamable",
          url: convertOpenCodeEnvSyntax(url),
        };

        // Handle headers
        if (serverObj.headers && typeof serverObj.headers === "object") {
          serverConfig.headers = convertOpenCodeEnvInObject(
            serverObj.headers as Record<string, string>,
          );
        }

        mcpServers[name] = serverConfig;
      }
    }

    if (Object.keys(mcpServers).length === 0) {
      return { success: false, reason: "empty-mcp" };
    }

    return { success: true, config: { mcpServers } };
  } catch {
    return { success: false, reason: "invalid-format" };
  }
}

/**
 * Parse Codex TOML config format into RouterMCP format.
 *
 * Codex format (TOML):
 * [mcp_servers.server-name]
 * command = "cmd"
 * args = ["arg1", "arg2"]
 * env = { KEY = "value" }
 * # OR for HTTP:
 * url = "https://..."
 * bearer_token_env_var = "API_KEY"
 * enabled_tools = ["tool1", "tool2"]
 * disabled_tools = ["tool3"]
 */
function parseCodexConfig(content: string): ParseConfigResult {
  try {
    const parsed = parseToml(content);
    if (!parsed || typeof parsed !== "object") {
      return { success: false, reason: "invalid-format" };
    }

    // Codex uses "mcp_servers" section
    const mcpServersSection = parsed.mcp_servers;
    if (!mcpServersSection || typeof mcpServersSection !== "object") {
      return { success: false, reason: "no-mcp-section" };
    }

    const mcpServers: Record<string, ServerConfig> = {};

    for (const [name, server] of Object.entries(mcpServersSection)) {
      if (!server || typeof server !== "object") continue;

      const serverObj = server as Record<string, unknown>;

      if (serverObj.command) {
        // stdio transport
        const command = serverObj.command as string;
        const args = serverObj.args as string[] | undefined;

        const serverConfig: ServerConfig = {
          transport: "stdio",
          command,
        };

        if (args && Array.isArray(args) && args.length > 0) {
          serverConfig.args = args;
        }

        // Handle environment variables
        if (serverObj.env && typeof serverObj.env === "object") {
          serverConfig.env = serverObj.env as Record<string, string>;
        }

        // Handle tool filtering
        if (serverObj.enabled_tools && Array.isArray(serverObj.enabled_tools)) {
          serverConfig.allowedTools = serverObj.enabled_tools as string[];
        }
        if (serverObj.disabled_tools && Array.isArray(serverObj.disabled_tools)) {
          serverConfig.denyTools = serverObj.disabled_tools as string[];
        }

        mcpServers[name] = serverConfig;
      } else if (serverObj.url) {
        // HTTP transport
        const url = serverObj.url as string;

        const serverConfig: ServerConfig = {
          transport: "http-streamable",
          url,
        };

        // Handle bearer_token_env_var -> Authorization header
        if (serverObj.bearer_token_env_var) {
          const envVar = serverObj.bearer_token_env_var as string;
          serverConfig.headers = {
            // Auto-converted from bearer_token_env_var
            Authorization: `Bearer \${env:${envVar}}`,
          };
        }

        // Handle tool filtering
        if (serverObj.enabled_tools && Array.isArray(serverObj.enabled_tools)) {
          serverConfig.allowedTools = serverObj.enabled_tools as string[];
        }
        if (serverObj.disabled_tools && Array.isArray(serverObj.disabled_tools)) {
          serverConfig.denyTools = serverObj.disabled_tools as string[];
        }

        mcpServers[name] = serverConfig;
      }
    }

    if (Object.keys(mcpServers).length === 0) {
      return { success: false, reason: "empty-mcp" };
    }

    return { success: true, config: { mcpServers } };
  } catch {
    return { success: false, reason: "invalid-format" };
  }
}

/**
 * Parse standard MCP config format (Cursor, Claude Code).
 */
function parseStandardMcpConfig(content: string): ParseConfigResult {
  try {
    const parsed = parseJsonc(content);

    // Validate structure
    if (!parsed || typeof parsed !== "object") {
      return { success: false, reason: "invalid-format" };
    }

    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      return { success: false, reason: "no-mcp-section" };
    }

    if (Object.keys(parsed.mcpServers).length === 0) {
      return { success: false, reason: "empty-mcp" };
    }

    return { success: true, config: parsed as RouterMcpConfig };
  } catch {
    return { success: false, reason: "invalid-format" };
  }
}

/**
 * Read and parse a client's MCP config file.
 * Returns null if the file doesn't exist.
 * Returns ParseConfigResult for all other cases (success or specific failure reasons).
 */
async function readClientConfig(
  path: string,
  client: MigrationClient,
): Promise<ParseConfigResult | null> {
  try {
    const f = file(path);
    if (!(await f.exists())) {
      return null;
    }
    const content = await f.text();

    // Dispatch to appropriate parser based on client
    switch (client) {
      case "opencode":
        return parseOpenCodeConfig(content);
      case "codex":
        return parseCodexConfig(content);
      case "cursor":
      case "claude-code":
      default:
        return parseStandardMcpConfig(content);
    }
  } catch {
    return { success: false, reason: "invalid-format" };
  }
}

/**
 * Merge servers from source config into target config.
 * Handles name collisions by prompting user.
 */
async function mergeServerConfigs(
  target: RouterMcpConfig,
  source: RouterMcpConfig,
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
 * Replace a client's project-level MCP config with routermcp proxy.
 * Only works for project-level configs (Cursor, Claude Code).
 */
async function replaceClientConfig(client: MigrationClient, level: MigrationLevel): Promise<void> {
  const configPath = getMcpClientConfigPath(client, level);
  if (!configPath) {
    p.log.error(`Cannot replace ${getClientLabel(client)} config at ${level} level`);
    return;
  }

  // Generate appropriate config based on client
  let newConfig: string;

  if (client === "codex") {
    // Codex uses TOML format
    const tomlConfig = {
      mcp_servers: {
        routermcp: {
          command: "bunx",
          args: ["-y", "routermcp"],
        },
      },
    };
    newConfig = stringifyToml(tomlConfig);
  } else if (client === "opencode") {
    // OpenCode uses different JSON structure
    const opencodeConfig = {
      mcp: {
        routermcp: {
          type: "local",
          command: ["bunx", "-y", "routermcp"],
        },
      },
    };
    newConfig = JSON.stringify(opencodeConfig, null, 2);
  } else {
    // Standard MCP config (Cursor, Claude Code)
    const standardConfig = {
      mcpServers: {
        routermcp: {
          command: "bunx",
          args: ["-y", "routermcp"],
        },
      },
    };
    newConfig = JSON.stringify(standardConfig, null, 2);
  }

  try {
    await write(configPath, newConfig);
    p.log.success(`Replaced ${getClientLabel(client)} config with routermcp proxy`);
  } catch (err) {
    p.log.error(`Failed to replace config: ${err}`);
  }
}

/**
 * Modify a JSON/JSONC file while preserving comments.
 * Uses jsonc-parser's modify and applyEdits for comment-preserving edits.
 */
async function modifyJsoncFile(
  filePath: string,
  jsonPath: (string | number)[],
  value: unknown,
): Promise<void> {
  const f = file(filePath);
  let content = (await f.exists()) ? await f.text() : "{}";

  const edits = modify(content, jsonPath, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  const result = applyEdits(content, edits);

  await write(filePath, result);
}

/**
 * Add routermcp entry to a client's global config.
 * This preserves existing servers (and comments for JSON files) and just adds routermcp.
 */
async function addRoutermcpToClientConfig(
  client: MigrationClient,
  level: MigrationLevel,
): Promise<void> {
  const configPath = getMcpClientConfigPath(client, level);
  if (!configPath) {
    p.log.error(`Cannot add to ${getClientLabel(client)} config at ${level} level`);
    return;
  }

  try {
    if (client === "codex") {
      // Codex uses TOML format - no comment preservation needed for current usage
      const f = file(configPath);
      const exists = await f.exists();
      const content = exists ? await f.text() : "";

      let tomlConfig: Record<string, unknown> = {};
      if (content) {
        try {
          tomlConfig = parseToml(content) as Record<string, unknown>;
        } catch {
          // If parsing fails, start fresh
        }
      }

      // Ensure mcp_servers section exists
      if (!tomlConfig.mcp_servers || typeof tomlConfig.mcp_servers !== "object") {
        tomlConfig.mcp_servers = {};
      }

      // Add routermcp entry
      (tomlConfig.mcp_servers as Record<string, unknown>).routermcp = {
        command: "bunx",
        args: ["-y", "routermcp"],
      };

      await write(configPath, stringifyToml(tomlConfig));
      p.log.success(`Added routermcp to ${getClientLabel(client)} config`);
    } else if (client === "opencode") {
      // OpenCode uses JSON format with "mcp" key - preserve comments
      await modifyJsoncFile(configPath, ["mcp", "routermcp"], {
        type: "local",
        command: ["bunx", "-y", "routermcp"],
      });
      p.log.success(`Added routermcp to ${getClientLabel(client)} config`);
    } else if (client === "cursor" || client === "claude-code") {
      // Cursor and Claude Code use standard JSON format with "mcpServers" key - preserve comments
      await modifyJsoncFile(configPath, ["mcpServers", "routermcp"], {
        command: "bunx",
        args: ["-y", "routermcp"],
      });
      p.log.success(`Added routermcp to ${getClientLabel(client)} config`);
    }
  } catch (err) {
    p.log.error(`Failed to add routermcp to config: ${err}`);
  }
}

/**
 * Migrate servers from an MCP client config.
 */
async function migrateFromClient(config: RouterMcpConfig, scope: ConfigScope): Promise<void> {
  // 1. Get available migration sources for this scope
  const sources = await getAvailableMigrationSources(scope);

  if (sources.length === 0) {
    p.log.warn("No migration sources found for this scope");
    return;
  }

  // 2. Select source to migrate from
  const selectedSource = await p.select({
    message: "Select MCP client config to migrate from:",
    options: sources.map((source) => ({
      value: source,
      label: source.label,
      hint: truncate(source.path, 50),
    })),
  });

  if (p.isCancel(selectedSource)) return;

  const source = selectedSource as MigrationSource;
  const clientLabel = getClientLabel(source.client);

  // 3. Read and parse config
  const spinner = p.spinner();
  spinner.start(`Reading ${clientLabel} config...`);

  const parseResult = await readClientConfig(source.path, source.client);

  // Handle file not found
  if (!parseResult) {
    spinner.stop("Config file not found");
    p.log.error(`Config file not found at: ${source.path}`);
    return;
  }

  // Handle parse failures with specific reasons
  if (!parseResult.success) {
    spinner.stop("No MCP servers found");

    if (parseResult.reason === "no-mcp-section" || parseResult.reason === "empty-mcp") {
      p.log.warn(`No MCP servers configured in ${clientLabel}`);

      // Offer to add routermcp instead
      const shouldAdd = await p.confirm({
        message: `Would you like to add routermcp to ${clientLabel} config instead?`,
        initialValue: true,
      });

      if (!p.isCancel(shouldAdd) && shouldAdd) {
        await addRoutermcpToClientConfig(source.client, source.level);
      }
    } else {
      p.log.error(`Could not parse ${clientLabel} config (invalid format)`);
    }
    return;
  }

  const clientConfig = parseResult.config;
  const serverCount = Object.keys(clientConfig.mcpServers).length;
  spinner.stop(`Found ${serverCount} servers in ${clientLabel} config`);

  if (serverCount === 0) {
    p.log.warn("No servers to migrate");
    return;
  }

  // 4. List servers to migrate
  p.log.info("Servers to migrate:");
  for (const [name, server] of Object.entries(clientConfig.mcpServers)) {
    const details = server.command
      ? `command: ${server.command}`
      : server.url
        ? `url: ${server.url}`
        : "unknown";
    p.log.message(`  ${name} - ${details}`);
  }

  // 5. Confirm migration
  const confirmMigrate = await p.confirm({
    message: `Migrate ${serverCount} servers from ${clientLabel}?`,
    initialValue: true,
  });

  if (p.isCancel(confirmMigrate) || !confirmMigrate) return;

  // 6. Merge servers
  const mergedCount = await mergeServerConfigs(config, clientConfig);
  p.log.success(`Migrated ${mergedCount} servers`);

  // 7. Ask about updating the source client config
  // Behavior differs based on migration level
  if (source.level === "project") {
    // Project-level: offer to replace entire config with routermcp proxy
    const shouldReplace = await p.confirm({
      message: `Replace ${clientLabel}'s config with routermcp proxy?\nThis will replace all servers with a single routermcp entry.`,
      initialValue: false,
    });

    if (!p.isCancel(shouldReplace) && shouldReplace) {
      await replaceClientConfig(source.client, source.level);
    }
  } else {
    // Global-level: offer to ADD routermcp entry (highly recommended)
    const shouldAdd = await p.confirm({
      message: `Add routermcp to ${clientLabel}'s global config?\nHighly recommended for routermcp to work with ${clientLabel}.`,
      initialValue: true,
    });

    if (!p.isCancel(shouldAdd) && shouldAdd) {
      await addRoutermcpToClientConfig(source.client, source.level);
    }
  }
}

/**
 * Configure MCP clients to use routermcp.
 * Detects available MCP clients and allows adding routermcp to their configs.
 */
async function configMcpClients(scope: ConfigScope): Promise<void> {
  // Determine level based on scope
  const level: MigrationLevel = scope === "user-global" ? "global" : "project";
  const levelLabel = level === "global" ? "global" : "project-level";

  p.log.info(`Detecting MCP clients at ${levelLabel}...`);

  // Detect all clients
  const detectedClients = await detectMcpClients(level);

  if (detectedClients.length === 0) {
    p.log.warn("No MCP clients detected");
    return;
  }

  // Build multi-select options
  const options = detectedClients.map((dc) => {
    const label = getClientLabel(dc.client);
    let hint = "";

    if (dc.hasRoutermcp) {
      hint = "routermcp already configured";
    } else if (dc.exists) {
      hint = "config exists";
    } else {
      hint = "config will be created";
    }

    return {
      value: dc,
      label,
      hint,
    };
  });

  // Multi-select
  const selected = await p.multiselect({
    message: "Select MCP clients to configure with routermcp:",
    options,
    required: false,
  });

  if (p.isCancel(selected) || selected.length === 0) {
    p.log.info("No clients selected");
    return;
  }

  const selectedClients = selected as DetectedClient[];

  // Process each selected client
  const results: Array<{
    client: string;
    status: "added" | "skipped" | "created" | "error";
    message?: string;
  }> = [];

  for (const dc of selectedClients) {
    const clientLabel = getClientLabel(dc.client);

    // If config doesn't exist, ask user if they want to create it
    if (!dc.exists) {
      const shouldCreate = await p.confirm({
        message: `${clientLabel} config doesn't exist at ${dc.path}. Create it?`,
        initialValue: true,
      });

      if (p.isCancel(shouldCreate) || !shouldCreate) {
        results.push({ client: clientLabel, status: "skipped", message: "config not created" });
        continue;
      }
    }

    // Add routermcp to the client config
    try {
      await addRoutermcpToClientConfig(dc.client, dc.level);

      if (dc.hasRoutermcp) {
        results.push({ client: clientLabel, status: "added", message: "updated existing entry" });
      } else if (!dc.exists) {
        results.push({ client: clientLabel, status: "created", message: "config created" });
      } else {
        results.push({ client: clientLabel, status: "added" });
      }
    } catch (err) {
      results.push({ client: clientLabel, status: "error", message: String(err) });
    }
  }

  // Show summary
  p.log.info("\nSummary:");
  for (const result of results) {
    const icon = result.status === "error" ? "x" : result.status === "skipped" ? "-" : "+";
    const suffix = result.message ? ` (${result.message})` : "";
    p.log.message(`  ${icon} ${result.client}: ${result.status}${suffix}`);
  }
}

// ============================================================================
// Non-interactive config subcommands: add, remove, list
// ============================================================================

import type { ConfigAddOptions, ConfigListOptions, ConfigRemoveOptions } from "./index.js";

/**
 * Parse a command string into command and args.
 * Splits on whitespace, handling quoted strings.
 */
function parseCommandString(cmd: string): { command: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Load config for a specific scope, returning empty config if none exists.
 */
async function loadConfigForScope(scope: ConfigScope): Promise<RouterMcpConfig> {
  const configPath = getConfigPathForScope(scope);

  try {
    // Check both .jsonc and .json variants
    const jsoncFile = file(configPath);
    if (await jsoncFile.exists()) {
      return await loadConfig(configPath);
    }

    const jsonPath = configPath.replace(/\.jsonc$/, ".json");
    const jsonFile = file(jsonPath);
    if (await jsonFile.exists()) {
      return await loadConfig(jsonPath);
    }
  } catch {
    // Ignore errors, return empty config
  }

  return { mcpServers: {} };
}

/**
 * Add a server to config (non-interactive).
 */
export async function configAddCommand(options: ConfigAddOptions): Promise<void> {
  const { serverName, scope, force } = options;

  // Validate server name
  if (!/^[a-zA-Z0-9-_]+$/.test(serverName)) {
    console.error(`Error: Server name must be alphanumeric with hyphens/underscores: ${serverName}`);
    process.exit(1);
  }

  // Validate mutually exclusive options
  if (!options.command && !options.url) {
    console.error("Error: Must specify either --command or --url");
    process.exit(1);
  }
  if (options.command && options.url) {
    console.error("Error: Cannot specify both --command and --url");
    process.exit(1);
  }

  // Validate URL if provided
  if (options.url) {
    try {
      new URL(options.url);
    } catch {
      console.error(`Error: Invalid URL: ${options.url}`);
      process.exit(1);
    }
  }

  // Load existing config for scope
  const config = await loadConfigForScope(scope);

  // Check if server already exists
  if (config.mcpServers[serverName] && !force) {
    console.error(`Error: Server "${serverName}" already exists in ${getScopeLabel(scope)} config`);
    console.error("Use --force to overwrite");
    process.exit(1);
  }

  if (config.mcpServers[serverName] && force) {
    console.error(`Warning: Overwriting existing server "${serverName}"`);
  }

  // Build ServerConfig
  let serverConfig: ServerConfig;

  if (options.command) {
    // Parse command string if no explicit args provided
    let command: string;
    let args: string[] | undefined;

    if (options.args && options.args.length > 0) {
      // Use explicit args
      command = options.command;
      args = options.args;
    } else {
      // Auto-split command string
      const parsed = parseCommandString(options.command);
      command = parsed.command;
      args = parsed.args.length > 0 ? parsed.args : undefined;
    }

    serverConfig = {
      transport: "stdio",
      command,
      ...(args && { args }),
    };

    // Add env if provided
    if (Object.keys(options.env).length > 0) {
      serverConfig.env = options.env;
    }
  } else {
    // HTTP transport
    serverConfig = {
      transport: "http-streamable",
      url: options.url!,
    };

    // Add headers if provided
    if (Object.keys(options.headers).length > 0) {
      serverConfig.headers = options.headers;
    }
  }

  // Add tool filtering if provided
  if (options.allowTools && options.allowTools.length > 0) {
    const exact = options.allowTools.filter((t) => !t.includes("*"));
    const globs = options.allowTools.filter((t) => t.includes("*"));
    if (exact.length > 0) serverConfig.allowedTools = exact;
    if (globs.length > 0) serverConfig.allowedToolsGlob = globs;
  }

  if (options.denyTools && options.denyTools.length > 0) {
    const exact = options.denyTools.filter((t) => !t.includes("*"));
    const globs = options.denyTools.filter((t) => t.includes("*"));
    if (exact.length > 0) serverConfig.denyTools = exact;
    if (globs.length > 0) serverConfig.denyToolsGlob = globs;
  }

  // Add to config
  config.mcpServers[serverName] = serverConfig;

  // Ensure directory exists and save
  await ensureConfigDir(scope);
  const configPath = getConfigPathForScope(scope);
  const content = JSON.stringify(config, null, 2);

  try {
    await write(configPath, content);
    console.log(`Added server "${serverName}" to ${getScopeLabel(scope)} config`);
    console.log(`  Path: ${configPath}`);
  } catch (err) {
    console.error(`Error: Failed to save config: ${err}`);
    process.exit(1);
  }
}

/**
 * Remove a server from config (non-interactive).
 */
export async function configRemoveCommand(options: ConfigRemoveOptions): Promise<void> {
  const { serverName, scope } = options;

  if (scope) {
    // Remove from specific scope
    const config = await loadConfigForScope(scope);

    if (!config.mcpServers[serverName]) {
      console.error(`Error: Server "${serverName}" not found in ${getScopeLabel(scope)} config`);
      process.exit(1);
    }

    delete config.mcpServers[serverName];

    const configPath = getConfigPathForScope(scope);
    const content = JSON.stringify(config, null, 2);

    try {
      await write(configPath, content);
      console.log(`Removed server "${serverName}" from ${getScopeLabel(scope)} config`);
      console.log(`  Path: ${configPath}`);
    } catch (err) {
      console.error(`Error: Failed to save config: ${err}`);
      process.exit(1);
    }
  } else {
    // Search all scopes for the server
    const scopes: ConfigScope[] = ["project-local", "user-project", "user-global"];
    let found = false;

    for (const s of scopes) {
      const config = await loadConfigForScope(s);

      if (config.mcpServers[serverName]) {
        delete config.mcpServers[serverName];

        const configPath = getConfigPathForScope(s);
        const content = JSON.stringify(config, null, 2);

        try {
          await write(configPath, content);
          console.log(`Removed server "${serverName}" from ${getScopeLabel(s)} config`);
          console.log(`  Path: ${configPath}`);
          found = true;
          break;
        } catch (err) {
          console.error(`Error: Failed to save config: ${err}`);
          process.exit(1);
        }
      }
    }

    if (!found) {
      console.error(`Error: Server "${serverName}" not found in any config scope`);
      process.exit(1);
    }
  }
}

/**
 * List configured servers (non-interactive).
 */
export async function configListCommand(options: ConfigListOptions): Promise<void> {
  const { scope, json } = options;

  interface ServerInfo {
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    url?: string;
    scope: ConfigScope;
    path: string;
  }

  const servers: ServerInfo[] = [];
  const scopesToCheck: ConfigScope[] = scope ? [scope] : ["project-local", "user-project", "user-global"];

  for (const s of scopesToCheck) {
    const locations = await getConfigLocations();
    const loc = locations.find((l) => l.scope === s);

    if (!loc?.exists) continue;

    try {
      const config = await loadConfig(loc.path);

      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        servers.push({
          name,
          transport: serverConfig.transport,
          command: serverConfig.command,
          args: serverConfig.args,
          url: serverConfig.url,
          scope: s,
          path: loc.path,
        });
      }
    } catch {
      // Ignore errors loading config
    }
  }

  if (json) {
    console.log(JSON.stringify(servers, null, 2));
    return;
  }

  if (servers.length === 0) {
    console.log("No servers configured");
    return;
  }

  // Group by scope for display
  const byScope = new Map<ConfigScope, { path: string; servers: ServerInfo[] }>();

  for (const server of servers) {
    if (!byScope.has(server.scope)) {
      byScope.set(server.scope, { path: server.path, servers: [] });
    }
    byScope.get(server.scope)!.servers.push(server);
  }

  for (const [s, { path, servers: scopeServers }] of byScope) {
    console.log(`\n${getScopeLabel(s)} (${path}):`);

    for (const server of scopeServers) {
      const details =
        server.transport === "stdio"
          ? server.args
            ? `${server.command} ${server.args.join(" ")}`
            : server.command
          : server.url;
      console.log(`  ${server.name.padEnd(20)} ${server.transport.padEnd(16)} ${details}`);
    }
  }

  console.log();
}
