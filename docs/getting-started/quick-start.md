---
title: Quick Start
description: Get RouterMCP gateway running in 5 minutes
---

# Quick Start

Get your first MCP gateway running in under 5 minutes.

## Step 1: Create Configuration

The easiest way is to use the interactive wizard:

```bash
routermcp config
```

Or manually create `routermcp.jsonc` in your project root:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

This configures a single filesystem MCP server that exposes the current directory.

## Step 2: Start the Gateway

```bash
routermcp
```

That's it! The gateway is now running in stdio mode, ready to accept MCP connections.

## Step 3: Verify It's Working

With verbose logging enabled, you'll see the discovery process:

```bash
routermcp -v
```

Output:
```
[upstream] Discovering capabilities from 1 servers (concurrency: 5)
[upstream] Connecting to filesystem...
[upstream] Discovered filesystem: 5 tools, 0 resources, 0 prompts
[gateway] Aggregated: 5 tools, 0 resources, 0 prompts
[gateway] Gateway running
MCP Gateway ready (stdio mode)
```

## Step 4: Connect an MCP Client

Configure your MCP client (Claude Code, Cursor, etc.) to use RouterMCP:

```json
{
  "mcpServers": {
    "routermcp": {
      "command": "routermcp",
      "args": ["-c", "/path/to/routermcp.jsonc"]
    }
  }
}
```

## What's Next?

Now that you have a basic gateway running:

1. **Add more servers**: See [Server Configuration](../configuration/servers.md)
2. **Add filtering**: See [Filtering](../configuration/filtering.md)
3. **Use HTTP mode**: `routermcp --http 3000`
4. **Try daemon mode**: `routermcp connect` for shared access

## Common Starting Points

### Multiple Servers

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"]
    }
  }
}
```

### With Tool Filtering

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedToolsGlob": ["read_*", "list_*"],
      "denyTools": ["write_file", "delete_file"]
    }
  }
}
```

### HTTP Mode

```bash
routermcp --http 3000
```

Then connect clients to `http://localhost:3000/mcp`.

---

**Previous**: [Installation](installation.md) | **Next**: [First Configuration](first-config.md)
