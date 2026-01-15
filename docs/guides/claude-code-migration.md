---
title: Claude Code Migration
description: Migrate from Claude Code's native MCP configuration to RouterMCP
---

# Claude Code Migration

This guide shows how to migrate your existing Claude Code MCP configuration to RouterMCP.

## Why Migrate?

RouterMCP provides benefits over Claude Code's native MCP configuration:

| Feature | Claude Code Native | RouterMCP |
|---------|-------------------|-----------|
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
2. Select "Claude Code (.mcp.json)"
3. Review servers to migrate
4. Optionally replace Claude Code config with RouterMCP proxy

### Option 2: Manual Migration

#### Step 1: Locate Claude Code Config

Claude Code stores MCP configuration at:
```
<project>/.mcp.json
```

Example Claude Code config:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
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
      "allowedToolsGlob": ["read_*", "list_*", "search_*"],
      "denyTools": ["delete_file", "write_file"]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  },
  // Add features not available in Claude Code native
  "codeMode": {
    "enabled": true
  }
}
```

#### Step 3: Update Claude Code Config

Replace `.mcp.json` with:

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

## Configuration Compatibility

RouterMCP is designed to be compatible with Claude Code's configuration format.

### Transport Type Aliases

Claude Code uses `type` field. RouterMCP accepts both:

```jsonc
// Claude Code style (accepted by RouterMCP)
{
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["..."]
  }
}

// RouterMCP style
{
  "filesystem": {
    "transport": "stdio",  // Or just omit - auto-detected
    "command": "npx",
    "args": ["..."]
  }
}
```

### HTTP Transport

Claude Code uses `http`. RouterMCP accepts both:

```jsonc
// Claude Code style (accepted by RouterMCP)
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp"
  }
}

// RouterMCP style
{
  "api": {
    "transport": "http-streamable",
    "url": "https://api.example.com/mcp"
  }
}
```

## Added Features

After migration, you can use RouterMCP-specific features:

### Tool Filtering

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "allowedToolsGlob": ["read_*", "list_*"],
      "denyTools": ["delete_file"]
    }
  }
}
```

### Code Mode

```jsonc
{
  "codeMode": {
    "enabled": true,
    "timeout": 30000
  }
}
```

### OpenAPI Integration

```jsonc
{
  "openApiServers": {
    "petstore": {
      "spec": "https://petstore3.swagger.io/api/v3/openapi.json"
    }
  }
}
```

### Environment Variable Substitution

```jsonc
{
  "mcpServers": {
    "api": {
      "url": "${env:API_URL}",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}"
      }
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
[gateway] Discovered memory: 3 tools
[gateway] Aggregated: 8 tools, 0 resources, 0 prompts
[gateway] Ready - serving on stdio
```

### Test Through Claude Code

1. Restart Claude Code
2. Start a new conversation
3. Ask to list available tools
4. Verify all expected tools appear

## Using Daemon Mode

For better performance with multiple Claude Code instances:

Update `.mcp.json`:
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

Benefits:
- Shared gateway process
- Faster startup for subsequent instances
- Reduced resource usage

## Rollback

If you need to revert:

1. Restore original `.mcp.json`
2. Delete `routermcp.jsonc`
3. Restart Claude Code

Keep a backup of your original config before migration.

## Troubleshooting

### Claude Code Can't Connect

1. Check RouterMCP config is valid:
   ```bash
   routermcp doctor
   ```

2. Test RouterMCP standalone:
   ```bash
   routermcp serve -v
   ```

3. Check `.mcp.json` syntax

### Tools Missing

1. Check filtering rules in `routermcp.jsonc`
2. Run with verbose output:
   ```bash
   routermcp serve -v
   ```
3. Verify upstream servers are accessible

### Type Field Warning

If you see warnings about `type` vs `transport`:
- Both are accepted
- `transport` is preferred for RouterMCP configs
- `type` is kept for Claude Code compatibility

---

**Up**: [Guides](../guides/) | **See Also**: [Cursor Migration](cursor-migration.md), [Config Command](../commands/config.md)
