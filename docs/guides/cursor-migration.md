---
title: Cursor Migration
description: Migrate from Cursor's native MCP configuration to RouterMCP
---

# Cursor Migration

This guide shows how to migrate your existing Cursor MCP configuration to RouterMCP.

## Why Migrate?

RouterMCP provides benefits over Cursor's native MCP configuration:

| Feature | Cursor Native | RouterMCP |
|---------|--------------|-----------|
| Multiple servers | Yes | Yes |
| Tool filtering | No | Yes |
| Resource filtering | No | Yes |
| Session management | No | Yes |
| Lazy connections | No | Yes |
| Code Mode | No | Yes |
| OpenAPI integration | No | Yes |
| Daemon mode | No | Yes |

## Migration Options

### Option 1: Interactive Wizard

The easiest way to migrate:

```bash
routermcp config
```

1. Select "Migrate existing MCP Config (Cursor/Claude Code)"
2. Select "Cursor IDE (.cursor/mcp.json)"
3. Review servers to migrate
4. Optionally replace Cursor config with RouterMCP proxy

### Option 2: Manual Migration

#### Step 1: Locate Cursor Config

Cursor stores MCP configuration at:
```
<project>/.cursor/mcp.json
```

Example Cursor config:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

#### Step 2: Create RouterMCP Config

Create `routermcp.jsonc`:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      // Add filtering (optional)
      "allowedToolsGlob": ["read_*", "list_*"],
      "denyTools": ["delete_file"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      // Add filtering (optional)
      "denyToolsGlob": ["*_delete", "*_remove"]
    }
  }
}
```

#### Step 3: Update Cursor Config

Replace `.cursor/mcp.json` with:

```json
{
  "mcpServers": {
    "routermcp": {
      "command": "bunx",
      "args": ["-y", "routermcp"]
    }
  }
}
```

Or use npx:
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

## Configuration Differences

### Transport Type

Cursor uses `command` directly. RouterMCP auto-detects transport:

```jsonc
// Cursor config (also works in RouterMCP)
{
  "filesystem": {
    "command": "npx",
    "args": ["..."]
  }
}

// RouterMCP explicit transport (optional)
{
  "filesystem": {
    "transport": "stdio",  // Optional - auto-detected from "command"
    "command": "npx",
    "args": ["..."]
  }
}
```

### Environment Variables

Cursor passes env directly. RouterMCP supports substitution:

```jsonc
// Cursor
{
  "api": {
    "command": "node",
    "args": ["server.js"],
    "env": {
      "API_KEY": "hardcoded-key"  // Not ideal
    }
  }
}

// RouterMCP with env substitution
{
  "api": {
    "command": "node",
    "args": ["server.js"],
    "env": {
      "API_KEY": "${env:API_KEY}"  // From environment
    }
  }
}
```

### Filtering

RouterMCP adds filtering not available in Cursor:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      // Tool filtering
      "allowedToolsGlob": ["read_*", "list_*"],
      "denyTools": ["delete_file", "write_file"],
      // Resource filtering
      "denyResourcesGlob": ["**/secret/**"]
    }
  }
}
```

## Verifying Migration

### Test RouterMCP Directly

```bash
# Start gateway with verbose output
routermcp serve -v
```

Expected output:
```
[gateway] Discovered filesystem: 5 tools
[gateway] Discovered github: 12 tools
[gateway] Aggregated: 17 tools, 0 resources, 0 prompts
[gateway] Ready - serving on stdio
```

### Test Through Cursor

1. Restart Cursor
2. Open a conversation
3. Ask to list available tools
4. Verify all expected tools appear

## Rollback

If you need to revert:

1. Restore original `.cursor/mcp.json`
2. Delete `routermcp.jsonc`
3. Restart Cursor

Keep a backup of your original config before migration.

## Using Daemon Mode with Cursor

For better performance with multiple Cursor windows:

Update `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "routermcp": {
      "command": "bunx",
      "args": ["-y", "routermcp", "connect", "--stdio"]
    }
  }
}
```

This uses daemon mode:
- First Cursor window starts the daemon
- Subsequent windows connect to existing daemon
- Faster startup, shared upstream connections

## Troubleshooting

### Cursor Can't Connect

1. Check RouterMCP config is valid:
   ```bash
   routermcp doctor
   ```

2. Test RouterMCP standalone:
   ```bash
   routermcp serve -v
   ```

3. Check Cursor's `.cursor/mcp.json` syntax

### Tools Missing

1. Check filtering rules in `routermcp.jsonc`
2. Run with verbose output to see filtered tools
3. Verify upstream servers are accessible

### Performance Issues

Use daemon mode (see above) to share gateway across windows.

---

**Up**: [Guides](../guides/) | **See Also**: [Claude Code Migration](claude-code-migration.md), [Config Command](../commands/config.md)
