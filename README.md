# RouterMCP CLI

A Bun-based CLI MCP Gateway that aggregates multiple upstream MCP servers into a single unified interface with tool/resource/prompt filtering.

## Features

- **Multi-Server Aggregation**: Connect to multiple MCP servers and expose them through a single gateway
- **Filtering**: Control which tools, resources, and prompts are exposed using allow/deny lists and glob patterns
- **Transport Support**: Connect to upstream servers via stdio or HTTP streamable transports
- **Fault Tolerance**: Graceful degradation when upstream servers fail to connect
- **Name Collision Detection**: Errors on startup if duplicate tool/resource/prompt names are detected

## Installation

```bash
# Clone the repository
git clone https://github.com/AI-GenApps/routermcp-cli.git
cd routermcp-cli

# Install dependencies
bun install
```

## Quick Start

1. Create a configuration file (`routermcp.jsonc`):

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"],
      "allowedTools": ["read_file", "list_directory"]
    }
  }
}
```

2. Start the gateway:

```bash
bun run src/index.ts serve
```

Or use the interactive configuration wizard:

```bash
bun run src/index.ts config
```

## Configuration

RouterMCP uses a JSONC configuration file (supports comments). The file can be named:
- `routermcp.jsonc`
- `routermcp.json`
- `.routermcp.jsonc`
- `.routermcp.json`

### Configuration Format

```jsonc
{
  "mcpServers": {
    "<server-name>": {
      // Transport configuration
      "transport": "stdio" | "http-streamable",
      
      // Stdio options
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-example"],
      "env": { "KEY": "value" },
      
      // HTTP options
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer ${ENV_VAR}"
      },
      
      // Tool filtering
      "allowedTools": ["tool1", "tool2"],
      "denyTools": ["dangerous_tool"],
      "allowedToolsGlob": ["read_*"],
      "denyToolsGlob": ["*_delete_*"],
      
      // Resource filtering
      "allowedResources": ["file:///allowed"],
      "denyResources": ["file:///secret"],
      "allowedResourcesGlob": ["file:///public/*"],
      "denyResourcesGlob": ["file:///private/*"],
      
      // Prompt filtering
      "allowedPrompts": ["safe_prompt"],
      "denyPrompts": ["admin_prompt"],
      "allowedPromptsGlob": ["user_*"],
      "denyPromptsGlob": ["system_*"]
    }
  }
}
```

### Environment Variable Substitution

Headers and other string values support `${ENV_VAR}` syntax for environment variable substitution.

### Filtering Logic

The filtering logic follows this order of precedence:
1. If `denyList` contains exact match → **DENY**
2. If `denyGlob` matches → **DENY**
3. If `allowList` defined and contains match → **ALLOW**
4. If `allowGlob` defined and matches → **ALLOW**
5. If no allow rules defined → **ALLOW** (default permit)
6. Otherwise → **DENY**

## CLI Usage

```
RouterMCP CLI - MCP Gateway that aggregates multiple upstream servers

USAGE:
  routermcp [command] [options]

COMMANDS:
  serve     Start the MCP gateway server (default)
  config    Run interactive configuration wizard

OPTIONS:
  -c, --config <path>      Path to configuration file
  -t, --transport <type>   Transport type (stdio, http-streamable)
  -p, --port <number>      Port for HTTP transport
  -h, --help               Show this help message
  -v, --version            Show version
```

## Development

```bash
# Install dependencies
bun install

# Run type check
bun run typecheck

# Run tests
bun test

# Build
bun run build
```

## Project Structure

```
routermcp-cli/
├── package.json
├── tsconfig.json
├── README.md
├── routermcp.jsonc.example
│
└── src/
    ├── index.ts                 # CLI entry point
    │
    ├── cli/
    │   ├── index.ts             # Command router
    │   ├── serve.ts             # Main gateway command
    │   └── config.ts            # Interactive config wizard
    │
    ├── config/
    │   ├── index.ts             # Config exports
    │   ├── types.ts             # TypeScript interfaces
    │   ├── schema.ts            # Zod validation schemas
    │   └── loader.ts            # JSONC file discovery/parsing
    │
    ├── core/
    │   ├── gateway.ts           # Main orchestrator
    │   ├── upstream.ts          # Upstream connection manager
    │   └── aggregator.ts        # Tools/resources/prompts aggregation
    │
    ├── transports/
    │   ├── index.ts             # Transport factory
    │   ├── stdio.ts             # Stdio client
    │   └── http-streamable.ts   # HTTP streamable client
    │
    ├── filtering/
    │   ├── index.ts             # Filter exports
    │   ├── filter.ts            # Allow/deny logic
    │   └── collision.ts         # Name collision detection
    │
    └── utils/
        └── errors.ts            # Custom error types
```

## License

MIT