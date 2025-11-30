import {
  select,
  input,
  confirm,
  checkbox,
} from "@inquirer/prompts";
import type {
  RouterMcpConfig,
  McpServerConfig,
  LocalTransportConfig,
  HttpStreamableTransportConfig,
  TransportType,
  ToolInfo,
} from "../types.ts";
import { saveConfig, createDefaultConfig } from "./config-loader.ts";
import { connectToServer, fetchTools } from "./mcp-client.ts";

/**
 * Interactive configuration editor for routermcp
 */
export class ConfigEditor {
  private config: RouterMcpConfig;
  private configPath: string;

  constructor(config: RouterMcpConfig, configPath: string) {
    this.config = config;
    this.configPath = configPath;
  }

  /**
   * Start the interactive configuration flow
   */
  async run(): Promise<void> {
    let running = true;

    while (running) {
      const serverNames = Object.keys(this.config.mcpServers);
      const choices = [
        { name: "Add new MCP server", value: "add" },
        ...(serverNames.length > 0
          ? [
              { name: "Edit existing server", value: "edit" },
              { name: "Remove server", value: "remove" },
              { name: "Configure tools for server", value: "tools" },
            ]
          : []),
        { name: "View current configuration", value: "view" },
        { name: "Save and exit", value: "save" },
        { name: "Exit without saving", value: "exit" },
      ];

      const action = await select({
        message: "What would you like to do?",
        choices,
      });

      switch (action) {
        case "add":
          await this.addServer();
          break;
        case "edit":
          await this.editServer();
          break;
        case "remove":
          await this.removeServer();
          break;
        case "tools":
          await this.configureTools();
          break;
        case "view":
          this.viewConfig();
          break;
        case "save":
          this.save();
          running = false;
          break;
        case "exit":
          running = false;
          break;
      }
    }
  }

  /**
   * Add a new MCP server configuration
   */
  private async addServer(): Promise<void> {
    const name = await input({
      message: "Enter server name (unique identifier):",
      validate: (value) => {
        if (!value.trim()) return "Server name is required";
        if (this.config.mcpServers[value]) return "Server name already exists";
        return true;
      },
    });

    const transport = await select<TransportType>({
      message: "Select transport type:",
      choices: [
        { name: "Local (stdio)", value: "local" },
        { name: "HTTP Streamable", value: "http-streamable" },
      ],
    });

    let serverConfig: McpServerConfig;

    if (transport === "local") {
      serverConfig = await this.configureLocalTransport();
    } else {
      serverConfig = await this.configureHttpStreamableTransport();
    }

    this.config.mcpServers[name] = serverConfig;
    console.log(`\nServer "${name}" added successfully!`);
  }

  /**
   * Configure local transport settings
   */
  private async configureLocalTransport(): Promise<LocalTransportConfig> {
    const command = await input({
      message: "Enter command to execute:",
      validate: (value) => (value.trim() ? true : "Command is required"),
    });

    const argsStr = await input({
      message: "Enter arguments (space-separated, leave empty for none):",
    });

    const args = argsStr.trim() ? argsStr.trim().split(/\s+/) : undefined;

    const cwd = await input({
      message: "Enter working directory (leave empty for current):",
    });

    return {
      transport: "local",
      command,
      ...(args && { args }),
      ...(cwd.trim() && { cwd: cwd.trim() }),
    };
  }

  /**
   * Configure HTTP streamable transport settings
   */
  private async configureHttpStreamableTransport(): Promise<HttpStreamableTransportConfig> {
    const url = await input({
      message: "Enter server URL:",
      validate: (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return "Please enter a valid URL";
        }
      },
    });

    return {
      transport: "http-streamable",
      url,
    };
  }

  /**
   * Edit an existing server configuration
   */
  private async editServer(): Promise<void> {
    const serverNames = Object.keys(this.config.mcpServers);
    if (serverNames.length === 0) {
      console.log("\nNo servers configured.");
      return;
    }

    const name = await select({
      message: "Select server to edit:",
      choices: serverNames.map((n) => ({ name: n, value: n })),
    });

    const currentConfig = this.config.mcpServers[name];
    if (!currentConfig) return;

    console.log(`\nCurrent configuration for "${name}":`);
    console.log(JSON.stringify(currentConfig, null, 2));

    const editTransport = await confirm({
      message: "Do you want to reconfigure the transport settings?",
      default: false,
    });

    if (editTransport) {
      const transport = await select<TransportType>({
        message: "Select transport type:",
        choices: [
          { name: "Local (stdio)", value: "local" },
          { name: "HTTP Streamable", value: "http-streamable" },
        ],
        default: currentConfig.transport,
      });

      let newConfig: McpServerConfig;
      if (transport === "local") {
        newConfig = await this.configureLocalTransport();
      } else {
        newConfig = await this.configureHttpStreamableTransport();
      }

      // Preserve tool filter settings
      this.config.mcpServers[name] = {
        ...newConfig,
        allowedTools: currentConfig.allowedTools,
        denyTools: currentConfig.denyTools,
        allowedToolsGlob: currentConfig.allowedToolsGlob,
        denyToolsGlob: currentConfig.denyToolsGlob,
      };

      console.log(`\nServer "${name}" updated!`);
    }
  }

  /**
   * Remove a server configuration
   */
  private async removeServer(): Promise<void> {
    const serverNames = Object.keys(this.config.mcpServers);
    if (serverNames.length === 0) {
      console.log("\nNo servers configured.");
      return;
    }

    const name = await select({
      message: "Select server to remove:",
      choices: serverNames.map((n) => ({ name: n, value: n })),
    });

    const confirmed = await confirm({
      message: `Are you sure you want to remove "${name}"?`,
      default: false,
    });

    if (confirmed) {
      delete this.config.mcpServers[name];
      console.log(`\nServer "${name}" removed.`);
    }
  }

  /**
   * Configure tool filtering for a server
   */
  private async configureTools(): Promise<void> {
    const serverNames = Object.keys(this.config.mcpServers);
    if (serverNames.length === 0) {
      console.log("\nNo servers configured.");
      return;
    }

    const name = await select({
      message: "Select server to configure tools:",
      choices: serverNames.map((n) => ({ name: n, value: n })),
    });

    const serverConfig = this.config.mcpServers[name];
    if (!serverConfig) return;

    const connectAndFetch = await confirm({
      message: "Would you like to connect to the server and fetch available tools?",
      default: true,
    });

    let tools: ToolInfo[] = [];
    if (connectAndFetch) {
      try {
        console.log(`\nConnecting to ${name}...`);
        const connection = await connectToServer(name, serverConfig);
        tools = await fetchTools(connection.client);
        await connection.close();
        console.log(`Found ${tools.length} tools.`);
      } catch (error) {
        console.error(`Failed to connect: ${error}`);
      }
    }

    const filterAction = await select({
      message: "How would you like to configure tools?",
      choices: [
        { name: "Allow all tools", value: "all" },
        ...(tools.length > 0
          ? [
              { name: "Select specific tools to allow", value: "select-allow" },
              { name: "Select specific tools to deny", value: "select-deny" },
            ]
          : []),
        { name: "Enter glob patterns for allowed tools", value: "glob-allow" },
        { name: "Enter glob patterns for denied tools", value: "glob-deny" },
        { name: "Clear all filters", value: "clear" },
        { name: "Cancel", value: "cancel" },
      ],
    });

    switch (filterAction) {
      case "all":
        delete serverConfig.allowedTools;
        delete serverConfig.allowedToolsGlob;
        console.log("\nAll tools will be allowed (respecting any deny rules).");
        break;

      case "select-allow":
        if (tools.length > 0) {
          const selectedTools = await checkbox({
            message: "Select tools to allow:",
            choices: tools.map((t) => ({
              name: t.description ? `${t.name} - ${t.description}` : t.name,
              value: t.name,
              checked: serverConfig.allowedTools?.includes(t.name) ?? false,
            })),
          });
          serverConfig.allowedTools = selectedTools;
          console.log(`\n${selectedTools.length} tools selected.`);
        }
        break;

      case "select-deny":
        if (tools.length > 0) {
          const selectedTools = await checkbox({
            message: "Select tools to deny:",
            choices: tools.map((t) => ({
              name: t.description ? `${t.name} - ${t.description}` : t.name,
              value: t.name,
              checked: serverConfig.denyTools?.includes(t.name) ?? false,
            })),
          });
          serverConfig.denyTools = selectedTools;
          console.log(`\n${selectedTools.length} tools will be denied.`);
        }
        break;

      case "glob-allow":
        const allowGlobs = await input({
          message: 'Enter glob patterns (comma-separated, e.g., "db:*,git:*"):',
          default: serverConfig.allowedToolsGlob?.join(",") ?? "",
        });
        serverConfig.allowedToolsGlob = allowGlobs
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);
        break;

      case "glob-deny":
        const denyGlobs = await input({
          message: 'Enter glob patterns (comma-separated, e.g., "admin:*"):',
          default: serverConfig.denyToolsGlob?.join(",") ?? "",
        });
        serverConfig.denyToolsGlob = denyGlobs
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);
        break;

      case "clear":
        delete serverConfig.allowedTools;
        delete serverConfig.denyTools;
        delete serverConfig.allowedToolsGlob;
        delete serverConfig.denyToolsGlob;
        console.log("\nAll tool filters cleared.");
        break;
    }
  }

  /**
   * View current configuration
   */
  private viewConfig(): void {
    console.log("\nCurrent configuration:");
    console.log(JSON.stringify(this.config, null, 2));
  }

  /**
   * Save configuration to file
   */
  private save(): void {
    saveConfig(this.configPath, this.config);
    console.log(`\nConfiguration saved to ${this.configPath}`);
  }
}

/**
 * Run the interactive config editor
 */
export async function runConfigEditor(
  config: RouterMcpConfig | null,
  configPath: string
): Promise<void> {
  const effectiveConfig = config ?? createDefaultConfig();
  const editor = new ConfigEditor(effectiveConfig, configPath);
  await editor.run();
}
