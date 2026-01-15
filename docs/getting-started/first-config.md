---
title: First Configuration
description: Understanding the RouterMCP configuration file
---

# First Configuration

RouterMCP uses a JSONC configuration file to define which MCP servers to aggregate.

## Configuration File Location

RouterMCP looks for configuration in this order:

1. Path specified with `-c, --config` flag
2. `./routermcp.jsonc` in current directory
3. `./routermcp.json` in current directory

## File Format

RouterMCP uses **JSONC** (JSON with Comments), which allows:
- Single-line comments: `// comment`
- Multi-line comments: `/* comment */`
- Trailing commas

## Basic Structure

```jsonc
{
  // MCP servers to aggregate
  "mcpServers": {
    "server-name": {
      // Server configuration
    }
  }
}
```

## Minimal Example

The simplest configuration with one server:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"]
    }
  }
}
```

## Server Types

RouterMCP supports two transport types:

### Stdio Servers (Local Processes)

For MCP servers that run as local commands:

```jsonc
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-package"],
      "env": {
        "API_KEY": "value"
      }
    }
  }
}
```

### HTTP Servers (Remote)

For MCP servers accessible via HTTP:

```jsonc
{
  "mcpServers": {
    "remote-server": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

## Transport Auto-Detection

RouterMCP automatically detects the transport type:
- `command` key → stdio transport
- `url` key → HTTP streamable transport

You can also be explicit with `"transport": "stdio"` or `"transport": "http-streamable"`.

## Using the Config Wizard

The interactive wizard helps you create a configuration:

```bash
routermcp config
```

The wizard will:
1. Ask about your servers
2. Help configure transports
3. Optionally set up filtering
4. Write the config file

## Full Configuration Options

See the complete reference:
- [Server Configuration](../configuration/servers.md)
- [Filtering](../configuration/filtering.md)
- [Environment Variables](../configuration/environment-variables.md)
- [HTTP & Sessions](../configuration/http-session.md)

## Validating Configuration

Use the doctor command to validate your config:

```bash
routermcp doctor
```

This checks:
- Configuration syntax
- Server connectivity
- OAuth requirements

---

**Previous**: [Quick Start](quick-start.md) | **Up**: [Getting Started](../index.md)
