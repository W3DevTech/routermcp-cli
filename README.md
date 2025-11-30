# routermcp-cli

MCP Gateway CLI - Proxy/aggregate multiple MCP servers into one.

## Overview

`routermcp-cli` is a Bun-based CLI package that acts as an **MCP Gateway**:

- Exposes **one MCP server** to the outside world
- Internally **proxies/aggregates multiple MCP servers** defined by the user in a config file
- **Filters which tools are exposed** from each upstream MCP server via allow/deny rules

## Installation

```bash
# Install globally
bun install -g routermcp-cli

# Or run directly
bunx routermcp-cli
```

## Quick Start

1. Create a configuration file:

```bash
routermcp config
```

2. Start the gateway:

```bash
routermcp
```

## Configuration

On startup, the CLI looks for a config file in the project root:

- `routermcp.jsonc` (preferred, supports comments)
- `routermcp.json`

### Configuration File Structure

```jsonc
{
  "mcpServers": {
    "serverA": {
      "transport": "local",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "allowedTools": ["read_file", "write_file"],
      "denyTools": ["delete_file"],
      "allowedToolsGlob": ["fs:*"],
      "denyToolsGlob": ["admin:*"]
    },
    "serverB": {
      "transport": "http-streamable",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Transport Types

#### Local (stdio)

Spawns a local process and communicates via stdio:

```jsonc
{
  "transport": "local",
  "command": "node",
  "args": ["server.js"],
  "env": { "NODE_ENV": "production" },
  "cwd": "/path/to/directory"
}
```

#### HTTP Streamable

Connects to an HTTP streamable MCP server:

```jsonc
{
  "transport": "http-streamable",
  "url": "http://localhost:3000/mcp",
  "headers": { "Authorization": "Bearer token" }
}
```

### Tool Filtering

Per MCP server, you can configure which tools are exposed:

- `allowedTools`: Explicit allow-list of tool names
- `denyTools`: Explicit deny-list of tool names
- `allowedToolsGlob`: Glob patterns to include tools (e.g., `db:*`)
- `denyToolsGlob`: Glob patterns to exclude tools

**Filter Logic:**

1. If `allowedTools` or `allowedToolsGlob` is set, only matching tools are allowed
2. `denyTools` and `denyToolsGlob` take precedence over allow rules
3. If no allow rules are specified, all tools are allowed by default (minus denies)

## CLI Commands

### Start Gateway (default)

```bash
routermcp
# or
routermcp start
```

Starts the MCP gateway server:

- Reads `routermcp.jsonc` or `routermcp.json`
- Connects to all configured upstream MCP servers
- Aggregates tools from all servers (applying filters)
- Exposes itself as one MCP server via stdio

### Interactive Configuration

```bash
routermcp config
```

Starts an interactive CLI where you can:

1. **Add a new MCP server** - Choose transport type and fill in details
2. **Edit existing servers** - Modify transport or filter settings
3. **Remove servers** - Delete server configurations
4. **Configure tools** - Connect to a server, fetch its tools, and set up filtering

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Run tests
bun test

# Type check
bun run typecheck
```

## License

MIT