---
title: Filtering
description: Control which tools, resources, and prompts are exposed
---

# Filtering

Filtering controls which tools, resources, and prompts from upstream servers are exposed through the gateway.

## Filter Precedence

Filters are evaluated in this order:

1. **Deny List (Exact)** - If name exactly matches `denyTools`, **denied**
2. **Deny Glob** - If name matches `denyToolsGlob` pattern, **denied**
3. **Allow List (Exact)** - If allow lists exist and name matches `allowedTools`, **allowed**
4. **Allow Glob** - If allow globs exist and name matches `allowedToolsGlob`, **allowed**
5. **Default** - If no allow rules defined, **allowed**; otherwise **denied**

> **Key Point**: Deny rules always win over allow rules.

## Tool Filtering

```jsonc
{
  "mcpServers": {
    "server": {
      "command": "...",

      // Exact matches
      "allowedTools": ["read_file", "list_directory"],
      "denyTools": ["delete_file", "write_file"],

      // Glob patterns
      "allowedToolsGlob": ["read_*", "list_*", "get_*"],
      "denyToolsGlob": ["delete_*", "remove_*", "*_admin"]
    }
  }
}
```

## Resource Filtering

Resources use URIs, same pattern:

```jsonc
{
  "mcpServers": {
    "server": {
      "command": "...",

      // Exact URIs
      "allowedResources": ["file:///safe/path", "https://api.example.com/data"],
      "denyResources": ["file:///secret/path"],

      // Glob patterns
      "allowedResourcesGlob": ["file:///safe/*", "https://public.api/*"],
      "denyResourcesGlob": ["**/secret/**", "file:///private/*"]
    }
  }
}
```

## Prompt Filtering

Same pattern for prompts:

```jsonc
{
  "mcpServers": {
    "server": {
      "command": "...",

      "allowedPrompts": ["commit_message", "pr_description"],
      "denyPrompts": ["admin_prompt"],
      "allowedPromptsGlob": ["safe_*", "public_*"],
      "denyPromptsGlob": ["admin_*", "*_secret"]
    }
  }
}
```

## Glob Pattern Syntax

RouterMCP uses [micromatch](https://github.com/micromatch/micromatch) for glob patterns:

| Pattern | Matches |
|---------|---------|
| `*` | Any characters except `/` |
| `**` | Any characters including `/` |
| `?` | Single character |
| `[abc]` | One of: a, b, or c |
| `[!abc]` | Not one of: a, b, or c |
| `{a,b}` | Either a or b |

## Filtering Strategies

### Allow-Only (Whitelist)

Only expose specific tools:

```jsonc
{
  "allowedToolsGlob": ["read_*", "list_*"]
}
```

Result: Only tools starting with `read_` or `list_` are exposed.

### Deny-Only (Blacklist)

Expose everything except dangerous tools:

```jsonc
{
  "denyToolsGlob": ["delete_*", "remove_*", "*_admin"]
}
```

Result: All tools except those matching deny patterns are exposed.

### Mixed Approach

Allow some patterns, deny specific items:

```jsonc
{
  "allowedToolsGlob": ["read_*"],
  "denyTools": ["read_sensitive_file"]
}
```

Result: Tools starting with `read_` are allowed, except `read_sensitive_file`.

### No Filters (Allow All)

```jsonc
{
  // No filtering options = allow all
}
```

Result: All tools/resources/prompts from the server are exposed.

## Examples

### Read-Only Filesystem

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "allowedToolsGlob": ["read_*", "list_*", "search_*"],
      "denyTools": ["write_file", "delete_file", "create_directory"]
    }
  }
}
```

### Database with Limited Access

```jsonc
{
  "mcpServers": {
    "database": {
      "url": "${env:DB_MCP_URL}",
      "allowedTools": ["query", "read_table"],
      "denyToolsGlob": ["*_delete", "*_drop", "*_truncate", "*_update"]
    }
  }
}
```

### API with Admin Exclusion

```jsonc
{
  "mcpServers": {
    "api": {
      "url": "https://api.example.com/mcp",
      "denyToolsGlob": ["admin_*", "*_admin", "manage_*"],
      "denyResourcesGlob": ["**/admin/**", "**/internal/**"]
    }
  }
}
```

## Troubleshooting

### Check Which Tools Are Exposed

Start with verbose logging:

```bash
routermcp -v
```

Output shows discovered vs filtered tools:

```
[upstream] Discovered filesystem: 10 tools, 5 filtered
[gateway] Aggregated: 5 tools (5 filtered by rules)
```

### Name Collisions

If two servers expose tools with the same name, the gateway fails:

```
Error: Name collision detected: read_file (filesystem, backup)
```

**Fix**: Use filtering to ensure unique names:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "allowedTools": ["read_file"]  // Keep this one
    },
    "backup": {
      "denyTools": ["read_file"]     // Filter this one
    }
  }
}
```

> **See Also**: [Server Configuration](servers.md), [Troubleshooting](../guides/troubleshooting.md)

---

**Previous**: [Servers](servers.md) | **Next**: [Environment Variables](environment-variables.md)
