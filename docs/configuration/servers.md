---
title: Server Configuration
description: Configure MCP servers for aggregation
---

# Server Configuration

Each server in `mcpServers` defines an upstream MCP server to aggregate.

## Basic Structure

```jsonc
{
  "mcpServers": {
    "server-name": {
      // Transport configuration (required)
      "command": "...",  // or "url": "..."

      // Optional settings
      "enabled": true,
      // ... filtering options
    }
  }
}
```

## Transport Types

RouterMCP supports two transport types, auto-detected from config keys.

### Stdio Transport

For MCP servers that run as local processes:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": {
        "DEBUG": "true",
        "API_KEY": "${env:MY_API_KEY}"
      },
      "cwd": "/working/directory"
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `command` | string | Command to execute (triggers stdio transport) |
| `args` | string[] | Command arguments |
| `env` | object | Environment variables for the process |
| `cwd` | string | Working directory |

### HTTP Transport

For remote MCP servers accessible via HTTP:

```jsonc
{
  "mcpServers": {
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}",
        "X-Custom-Header": "value"
      },
      "oauth": {
        "enabled": true,
        "clientId": "your-client-id"
      }
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `url` | string | MCP server URL (triggers HTTP transport) |
| `headers` | object | HTTP headers to include |
| `oauth` | object | OAuth configuration (see [OAuth](../commands/oauth.md)) |

OAuth clients use RouterMCP's hosted client metadata document by default. Set `oauth.clientMetadataUrl` to another public HTTPS document when using a fork or a self-hosted client identity.

## Transport Auto-Detection

RouterMCP automatically detects transport type:

- `command` key present → **stdio transport**
- `url` key present → **HTTP streamable transport**

You can also be explicit:

```jsonc
{
  "transport": "stdio",
  "command": "npx",
  "args": ["..."]
}
```

For Claude Code compatibility, `"type"` and `"http"` are also accepted.

## Enabling/Disabling Servers

Temporarily disable a server without removing it:

```jsonc
{
  "mcpServers": {
    "active-server": {
      "command": "npx",
      "args": ["active-package"],
      "enabled": true  // default
    },
    "disabled-server": {
      "command": "npx",
      "args": ["disabled-package"],
      "enabled": false  // server is skipped
    }
  }
}
```

## Filtering Options

Each server can have filtering rules:

```jsonc
{
  "mcpServers": {
    "server": {
      "command": "...",

      // Tool filtering
      "allowedTools": ["tool1", "tool2"],
      "denyTools": ["dangerous_tool"],
      "allowedToolsGlob": ["read_*", "list_*"],
      "denyToolsGlob": ["delete_*", "*_admin"],

      // Resource filtering
      "allowedResources": ["file:///safe/path"],
      "denyResources": ["file:///secret"],
      "allowedResourcesGlob": ["file:///safe/*"],
      "denyResourcesGlob": ["**/private/**"],

      // Prompt filtering
      "allowedPrompts": ["safe_prompt"],
      "denyPrompts": ["admin_prompt"],
      "allowedPromptsGlob": ["public_*"],
      "denyPromptsGlob": ["*_secret"]
    }
  }
}
```

> **See Also**: [Filtering](filtering.md) for detailed filtering rules

## Complete Example

```jsonc
{
  "mcpServers": {
    // Local filesystem server
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"],
      "allowedToolsGlob": ["read_*", "list_*", "search_*"],
      "denyTools": ["write_file", "delete_file"]
    },

    // Remote API server with authentication
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}",
        "X-API-Version": "v1"
      },
      "denyToolsGlob": ["admin_*", "*_delete"]
    },

    // Git server (disabled for now)
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"],
      "enabled": false
    }
  }
}
```

> **See Also**: [Filtering](filtering.md), [Environment Variables](environment-variables.md)

---

**Previous**: [Overview](overview.md) | **Next**: [Filtering](filtering.md)
