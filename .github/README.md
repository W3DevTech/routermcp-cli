# RouterMCP CLI

A Bun-based CLI MCP Gateway that aggregates multiple upstream MCP servers into a single unified interface with tool/resource/prompt filtering.

## Features

- **MCP Gateway**: Expose one MCP server that proxies multiple upstream servers
- **Tool Filtering**: Allow/deny tools per server using exact names or glob patterns
- **Resource Filtering**: Same filtering capabilities for resources
- **Prompt Filtering**: Same filtering capabilities for prompts
- **Multiple Transports**: Support stdio and HTTP streamable for both upstream and gateway
- **Graceful Degradation**: Continue operating if some upstream servers fail
- **Interactive Config**: CLI wizard for creating configuration files

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/routermcp-cli.git
cd routermcp-cli

# Install dependencies
bun install

# Run the CLI
bun run src/index.ts
```

## Quick Start

1. Create a configuration file:

```bash
bun run src/index.ts config
```

2. Or copy the example config:

```bash
cp routermcp.jsonc.example routermcp.jsonc
```

3. Start the gateway:

```bash
bun run src/index.ts
```

## Usage

### Commands

```bash
# Start the gateway (default command)
routermcp

# Start with HTTP transport
routermcp --http 3000

# Use custom config file
routermcp -c /path/to/config.jsonc

# Run interactive configuration wizard
routermcp config

# Show help
routermcp --help
```

### Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--stdio` | Use stdio transport (default) |
| `--http <port>` | Use HTTP streamable transport on specified port |
| `-v, --verbose` | Enable verbose logging |
| `-h, --help` | Show help |

## Configuration

Create a `routermcp.jsonc` file in your project root:

```jsonc
{
  "mcpServers": {
    // Stdio transport (auto-detected from "command")
    "local-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "KEY": "value" },
      "cwd": "/working/directory"
    },

    // HTTP transport (auto-detected from "url")
    "remote-server": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" },

      // Tool filtering (optional)
      "allowedTools": ["tool1", "tool2"],      // Exact allow list
      "denyTools": ["tool3"],                   // Exact deny list
      "allowedToolsGlob": ["read_*", "list_*"], // Glob patterns to allow
      "denyToolsGlob": ["delete_*", "*_admin"]  // Glob patterns to deny
    }
  }
}
```

> **Note:** Transport type is auto-detected from config keys:
> - `command` key → stdio transport
> - `url` key → HTTP streamable transport
>
> You can also use explicit `"transport": "stdio"` or `"transport": "http-streamable"`.
> For Claude Code compatibility, `"type"` and `"http"` are also accepted.

### Filtering Options

Each server supports optional filtering for tools, resources, and prompts:

```jsonc
{
  "allowedTools": ["tool1", "tool2"],      // Exact allow list
  "denyTools": ["tool3"],                   // Exact deny list
  "allowedToolsGlob": ["read_*", "list_*"], // Glob patterns to allow
  "denyToolsGlob": ["delete_*", "*_admin"], // Glob patterns to deny

  "allowedResources": ["file:///safe/*"],
  "denyResourcesGlob": ["**/secret/**"],

  "allowedPrompts": ["safe_prompt"],
  "denyPromptsGlob": ["admin_*"],

  "enabled": false  // Disable server without removing config
}
```

### Environment Variables

Use `${VAR_NAME}` syntax in config values to reference environment variables:

```jsonc
{
  "mcpServers": {
    "api": {
      "transport": "http-streamable",
      "url": "${API_URL}",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

### Filtering Rules

Filter precedence (in order):

1. **Deny list** - Exact match denies
2. **Deny glob** - Glob pattern match denies
3. **Allow list** - Exact match allows (if defined)
4. **Allow glob** - Glob pattern match allows (if defined)
5. **Default** - If no allow rules defined, allow all; otherwise deny

Examples:

```jsonc
{
  // Allow only read operations
  "allowedToolsGlob": ["read_*", "list_*", "get_*"]
}

{
  // Allow all except dangerous operations
  "denyToolsGlob": ["delete_*", "remove_*", "*_admin"]
}

{
  // Mixed: allow read operations but deny specific tool
  "allowedToolsGlob": ["read_*"],
  "denyTools": ["read_sensitive_file"]
}
```

## Error Handling

### Name Collisions

If multiple upstream servers expose tools/resources/prompts with the same name, the gateway will fail to start with a collision error. Resolve by:

1. Using filtering to expose only unique names
2. Renaming at the upstream server level

### Graceful Degradation

If an upstream server fails to connect:

- The gateway continues with available servers
- Failed servers are logged
- Their tools/resources/prompts are not exposed

## Development

```bash
# Run in development mode (with watch)
bun run dev

# Type check
bun run typecheck

# Run directly
bun run src/index.ts --help
```

## Architecture

```
src/
├── index.ts           # CLI entry point
├── cli/               # CLI commands and argument parsing
├── config/            # Configuration loading and validation
├── core/              # Gateway, upstream management, aggregation
├── transports/        # Stdio and HTTP transport implementations
├── filtering/         # Tool/resource/prompt filtering logic
└── utils/             # Error types and utilities
```

## License

MIT
