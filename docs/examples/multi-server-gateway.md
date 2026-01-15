---
title: Multi-Server Gateway
description: Aggregate multiple MCP servers into a single gateway
---

# Multi-Server Gateway

This example shows how to aggregate multiple MCP servers with different capabilities.

## Goal

Create a gateway that provides:
- Filesystem access (read-only)
- GitHub integration (safe operations)
- Memory/notes storage
- A REST API via OpenAPI

## Configuration

Create `routermcp.jsonc`:

```jsonc
{
  "strictEnvVars": true,

  "mcpServers": {
    // Local filesystem - read only
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedToolsGlob": ["read_*", "list_*", "search_*"],
      "denyTools": ["write_file", "delete_file", "create_directory"]
    },

    // GitHub - safe operations only
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      },
      "allowedToolsGlob": [
        "list_*",
        "get_*",
        "search_*",
        "create_issue",
        "create_pull_request"
      ],
      "denyToolsGlob": [
        "*_delete",
        "*_remove",
        "close_*"
      ]
    },

    // Memory server for notes
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
      // No filtering - all memory operations allowed
    }
  },

  // OpenAPI integration
  "openApiServers": {
    "jsonplaceholder": {
      "spec": "https://raw.githubusercontent.com/typicode/jsonplaceholder/master/openapi.json",
      "baseUrl": "https://jsonplaceholder.typicode.com",
      "allowedToolsGlob": ["get*"]  // Read-only
    }
  },

  // Connection settings
  "subprocess_timeout": 120,
  "discovery_concurrency": 3
}
```

## Required Environment Variables

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

## Start the Gateway

```bash
routermcp serve -v
```

Expected output:

```
[gateway] Discovered filesystem: 5 tools, 3 allowed
[gateway] Discovered github: 15 tools, 8 allowed
[gateway] Discovered memory: 4 tools
[gateway] Discovered jsonplaceholder: 12 tools, 6 allowed
[gateway] Aggregated: 21 tools, 0 resources, 0 prompts
[gateway] Ready - serving on stdio
```

## Handling Name Collisions

If two servers expose tools with the same name, the gateway fails:

```
Error: Name collision detected: list_items (server1, server2)
```

Resolution options:

### Option 1: Filter Out One

```jsonc
{
  "server1": {
    "allowedTools": ["list_items"]  // Keep this
  },
  "server2": {
    "denyTools": ["list_items"]     // Filter this
  }
}
```

### Option 2: Disable Server

```jsonc
{
  "server2": {
    "enabled": false
  }
}
```

## Using Daemon Mode

For multiple clients sharing the same gateway:

```bash
# First terminal (or in background)
routermcp connect

# Additional terminals
routermcp connect
```

## HTTP Mode for Remote Access

```jsonc
{
  "httpServer": {
    "port": 5151,
    "host": "127.0.0.1"
  },
  "session": {
    "timeout": 600,
    "max_sessions": 50
  }
}
```

Start with HTTP:

```bash
routermcp serve --http 5151
```

## Adding Code Mode

Enable JavaScript execution across all tools:

```jsonc
{
  "codeMode": {
    "enabled": true,
    "timeout": 30000,
    "allowFetch": true
  }
}
```

Now you can orchestrate tools with code:

```javascript
// Through routermcp.executeCode
const issues = await github.list_issues({ repo: "owner/repo" });
const notes = await memory.list_notes();

for (const issue of issues) {
  if (!notes.find(n => n.title === issue.title)) {
    await memory.create_note({
      title: issue.title,
      content: issue.body
    });
  }
}

return { synced: issues.length };
```

## Client Configuration

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "gateway": {
      "command": "npx",
      "args": ["-y", "routermcp", "--config", "routermcp.jsonc"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "gateway": {
      "command": "npx",
      "args": ["-y", "routermcp", "--config", "routermcp.jsonc"]
    }
  }
}
```

## Lazy Connection Flow

The gateway optimizes resources:

```
Startup:
  Connect all → Discover tools → Disconnect all

First github tool call:
  Reconnect github → Execute → Keep alive

After 120s idle:
  Disconnect github (subprocess_timeout)
```

---

**Previous**: [Basic Filesystem](basic-filesystem.md) | **Next**: [Remote HTTP Server](remote-http-server.md)
