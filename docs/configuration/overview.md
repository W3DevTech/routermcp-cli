---
title: Configuration Overview
description: RouterMCP configuration file format and structure
---

# Configuration Overview

RouterMCP uses a JSONC configuration file to define which MCP servers to aggregate and how to filter their capabilities.

## File Format

RouterMCP uses **JSONC** (JSON with Comments):

```jsonc
{
  // This is a comment
  "mcpServers": {
    "server": {
      /* Multi-line
         comment */
      "command": "npx",
      "args": ["package"], // Trailing commas OK
    }
  }
}
```

## File Location

RouterMCP looks for configuration in this order:

1. Path specified with `-c, --config` flag
2. `./routermcp.jsonc` in current directory
3. `./routermcp.json` in current directory

## Root Structure

```jsonc
{
  // MCP servers (at least one required)
  "mcpServers": {
    "server-name": { /* ... */ }
  },

  // OpenAPI servers (optional)
  "openApiServers": {
    "api-name": { /* ... */ }
  },

  // HTTP server settings (optional)
  "httpServer": {
    "port": 5151,
    "host": "127.0.0.1"
  },

  // Session settings (optional)
  "session": {
    "timeout": 300,
    "max_sessions": 25
  },

  // Code Mode settings (optional)
  "codeMode": {
    "enabled": false,
    "timeout": 30000,
    "allowFetch": true
  },

  // Behavior settings (optional)
  "subprocess_timeout": 180,
  "discovery_concurrency": 5,
  "connection_timeout": 30,
  "strictEnvVars": false
}
```

## Required Fields

At minimum, you need either `mcpServers` or `openApiServers` with at least one entry:

```jsonc
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-package"]
    }
  }
}
```

## Global Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `subprocess_timeout` | number | 180 | Seconds before idle upstream connections are closed |
| `discovery_concurrency` | number | 5 | Max parallel connections during discovery |
| `connection_timeout` | number | 30 | Seconds to wait for upstream connection |
| `strictEnvVars` | boolean | false | Fail if `${env:...}` cannot be resolved |

## Detailed Documentation

- [Server Configuration](servers.md) - MCP server settings
- [Filtering](filtering.md) - Tool/resource/prompt filtering
- [Environment Variables](environment-variables.md) - Variable substitution
- [OpenAPI Servers](openapi-servers.md) - OpenAPI-to-MCP conversion
- [HTTP & Sessions](http-session.md) - HTTP and session settings

## Validation

Validate your configuration with:

```bash
routermcp doctor
```

Or start with verbose logging to see issues:

```bash
routermcp -v
```

---

**Next**: [Server Configuration](servers.md)
