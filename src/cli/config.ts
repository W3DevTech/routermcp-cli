import { homedir } from "node:os";
import * as p from "@clack/prompts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
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
        listServers(config);
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
      server.transport === "stdio" ? `command: ${server.command}` : `url: ${server.url}`;
    p.log.message(`  ${name} (${server.transport}) - ${details}`);

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
function parseOpenCodeConfig(content: string): RouterMcpConfig | null {
  try {
    const parsed = parseJsonc(content);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    // OpenCode uses "mcp" key instead of "mcpServers"
    const mcpSection = parsed.mcp;
    if (!mcpSection || typeof mcpSection !== "object") {
      return null;
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
      return null;
    }

    return { mcpServers };
  } catch {
    return null;
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
function parseCodexConfig(content: string): RouterMcpConfig | null {
  try {
    const parsed = parseToml(content);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    // Codex uses "mcp_servers" section
    const mcpServersSection = parsed.mcp_servers;
    if (!mcpServersSection || typeof mcpServersSection !== "object") {
      return null;
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
      return null;
    }

    return { mcpServers };
  } catch {
    return null;
  }
}

/**
 * Parse standard MCP config format (Cursor, Claude Code).
 */
function parseStandardMcpConfig(content: string): RouterMcpConfig | null {
  try {
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
 * Read and parse a client's MCP config file.
 */
async function readClientConfig(
  path: string,
  client: MigrationClient,
): Promise<RouterMcpConfig | null> {
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
    return null;
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
 * Add routermcp entry to a client's global config.
 * This preserves existing servers and just adds routermcp.
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
    const f = file(configPath);
    const exists = await f.exists();
    let content = exists ? await f.text() : "";

    if (client === "codex") {
      // Codex uses TOML format
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
      // OpenCode uses JSON format with "mcp" key
      let jsonConfig: Record<string, unknown> = {};
      if (content) {
        try {
          jsonConfig = parseJsonc(content) as Record<string, unknown>;
        } catch {
          // If parsing fails, start fresh
        }
      }

      // Ensure mcp section exists
      if (!jsonConfig.mcp || typeof jsonConfig.mcp !== "object") {
        jsonConfig.mcp = {};
      }

      // Add routermcp entry
      (jsonConfig.mcp as Record<string, unknown>).routermcp = {
        type: "local",
        command: ["bunx", "-y", "routermcp"],
      };

      await write(configPath, JSON.stringify(jsonConfig, null, 2));
      p.log.success(`Added routermcp to ${getClientLabel(client)} config`);
    } else if (client === "cursor" || client === "claude-code") {
      // Cursor and Claude Code use standard JSON format with "mcpServers" key
      let jsonConfig: Record<string, unknown> = {};
      if (content) {
        try {
          jsonConfig = parseJsonc(content) as Record<string, unknown>;
        } catch {
          // If parsing fails, start fresh
        }
      }

      // Ensure mcpServers section exists
      if (!jsonConfig.mcpServers || typeof jsonConfig.mcpServers !== "object") {
        jsonConfig.mcpServers = {};
      }

      // Add routermcp entry
      (jsonConfig.mcpServers as Record<string, unknown>).routermcp = {
        command: "bunx",
        args: ["-y", "routermcp"],
      };

      await write(configPath, JSON.stringify(jsonConfig, null, 2));
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

  const clientConfig = await readClientConfig(source.path, source.client);

  if (!clientConfig) {
    spinner.stop("Config not found or invalid");
    p.log.error(`Could not parse ${clientLabel} config at: ${source.path}`);
    return;
  }

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
