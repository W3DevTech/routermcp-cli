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

That's it! RouterMCP has started (or reused) the managed gateway daemon and is
bridging this command's stdio to its authenticated loopback HTTP endpoint.
Use `routermcp serve` when you want a standalone foreground stdio process.

## Step 3: Verify It's Working

With verbose logging enabled, you'll see the discovery process:

```bash
routermcp connect -v
```

Output:
```
[connect] Using config: /path/to/routermcp.jsonc
Connected to daemon at /path/to/project (pid: 12345, url: http://127.0.0.1:7858/mcp)
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
3. **Use HTTP mode**: `routermcp serve --http 3000`
4. **Inspect daemon mode**: `routermcp status` for the shared process

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
routermcp serve --http 3000
```

Then connect clients to `http://localhost:3000/mcp`.

---

**Previous**: [Installation](installation.md) | **Next**: [First Configuration](first-config.md)
