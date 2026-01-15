---
title: Basic Filesystem Server
description: Simple example of proxying the filesystem MCP server
---

# Basic Filesystem Server

This example shows how to use RouterMCP with the official filesystem MCP server.

## Goal

Expose the filesystem MCP server with read-only access to a specific directory.

## Configuration

Create `routermcp.jsonc`:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/home/user/documents"
      ],
      // Only allow read operations
      "allowedToolsGlob": ["read_*", "list_*", "search_*"],
      // Explicitly deny write/delete
      "denyTools": ["write_file", "delete_file", "create_directory"]
    }
  }
}
```

## Start the Gateway

```bash
routermcp serve
```

Or with verbose logging:

```bash
routermcp serve -v
```

Expected output:

```
[gateway] Discovered filesystem: 5 tools
[gateway] Aggregated: 3 tools (2 filtered by rules)
[gateway] Ready - serving on stdio
```

## Available Tools

After filtering, these tools are available:

| Tool | Description |
|------|-------------|
| `read_file` | Read contents of a file |
| `list_directory` | List files in a directory |
| `search_files` | Search for files matching a pattern |

## Using with Claude Code

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "routermcp": {
      "command": "npx",
      "args": ["-y", "routermcp"]
    }
  }
}
```

## Using with Cursor

Create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "routermcp": {
      "command": "npx",
      "args": ["-y", "routermcp"]
    }
  }
}
```

## HTTP Mode

To expose via HTTP instead of stdio:

```bash
routermcp serve --http 3000
```

Then configure your client to connect to `http://localhost:3000/mcp`.

## Adding Multiple Directories

To allow access to multiple directories:

```jsonc
{
  "mcpServers": {
    "documents": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"],
      "allowedToolsGlob": ["read_*", "list_*"]
    },
    "code": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/code"],
      "allowedToolsGlob": ["read_*", "list_*", "search_*"]
    }
  }
}
```

Note: This causes a name collision. Use the [multi-server example](multi-server-gateway.md) to resolve it.

## Verifying Setup

Run the doctor command:

```bash
routermcp doctor
```

This validates the config and tests server connectivity.

---

**Up**: [Examples](../examples/) | **Next**: [Multi-Server Gateway](multi-server-gateway.md)
