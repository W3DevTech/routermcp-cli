---
title: Multiple Servers
description: Aggregate multiple MCP servers into a unified interface
---

# Multiple Servers

RouterMCP's core capability is aggregating multiple MCP servers into a single unified interface.

## Basic Aggregation

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    "database": {
      "url": "https://db.example.com/mcp"
    }
  }
}
```

All tools, resources, and prompts are merged into a single namespace.

## How Aggregation Works

### Discovery Phase

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  filesystem  │     │    github    │     │   database   │
│              │     │              │     │              │
│ - read_file  │     │ - create_pr  │     │ - query      │
│ - write_file │     │ - list_repos │     │ - insert     │
│ - list_dir   │     │ - get_issue  │     │ - update     │
└──────────────┘     └──────────────┘     └──────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                    ┌──────────────┐
                    │   Gateway    │
                    │              │
                    │ Aggregated:  │
                    │ - read_file  │
                    │ - write_file │
                    │ - list_dir   │
                    │ - create_pr  │
                    │ - list_repos │
                    │ - get_issue  │
                    │ - query      │
                    │ - insert     │
                    │ - update     │
                    └──────────────┘
```

1. Gateway connects to all upstreams in parallel
2. Calls `tools/list`, `resources/list`, `prompts/list` on each
3. Applies filtering rules per server
4. Merges results into unified capability set
5. Disconnects upstreams (lazy connection for subsequent calls)

### Routing Phase

When a tool is called:

```
Client: tools/call "read_file"
    │
    ▼
┌──────────────┐
│   Gateway    │ → Lookup: read_file → filesystem server
└──────────────┘
    │
    ▼
┌──────────────┐
│  filesystem  │ → Connect (if disconnected)
│   server     │ → Execute tool
└──────────────┘
    │
    ▼
Result returned to client
```

## Name Collision Handling

If two servers expose tools with the same name, the gateway fails at startup:

```
Error: Name collision detected: read_file (filesystem, backup)
```

### Resolution Strategies

#### Option 1: Filter Out Duplicates

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "allowedTools": ["read_file"]  // Keep this one
    },
    "backup": {
      "command": "...",
      "denyTools": ["read_file"]     // Filter this one
    }
  }
}
```

#### Option 2: Disable One Server

```jsonc
{
  "mcpServers": {
    "filesystem": { "command": "...", "enabled": true },
    "backup": { "command": "...", "enabled": false }
  }
}
```

## Lazy Connection Pattern

Upstreams use lazy connection to optimize resources:

```
┌─────────────────────────────────────────────────────────┐
│                    Gateway Lifecycle                     │
├─────────────────────────────────────────────────────────┤
│ 1. STARTUP: Connect all → Discover capabilities         │
│ 2. READY: Disconnect all (cache capabilities)           │
│ 3. CALL: Reconnect on-demand when tool is called        │
│ 4. IDLE: Disconnect after subprocess_timeout            │
└─────────────────────────────────────────────────────────┘
```

Configure idle timeout:

```jsonc
{
  "subprocess_timeout": 180  // Disconnect after 3 minutes idle
}
```

## Parallel Discovery

Multiple upstreams are discovered in parallel with configurable concurrency:

```jsonc
{
  "discovery_concurrency": 5  // Default: 5 parallel connections
}
```

```
Time ──────────────────────────────────────────────────▶

Batch 1:  [server-1] [server-2] [server-3] [server-4] [server-5]
Batch 2:  [server-6] [server-7] [server-8]
          ├─────────────────────────────────────────────┤
          │          All discovery complete             │
```

## Mixed Transport Types

Combine local and remote servers:

```jsonc
{
  "mcpServers": {
    // Local process (stdio)
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },

    // Remote HTTP server
    "cloud-api": {
      "url": "https://mcp.example.com/api",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}"
      }
    },

    // Another remote server with OAuth
    "github": {
      "url": "https://github.mcp.example.com",
      "oauth": {
        "enabled": true,
        "clientId": "your-client-id"
      }
    }
  }
}
```

## OpenAPI Integration

Add REST APIs as MCP tools alongside native MCP servers:

```jsonc
{
  "mcpServers": {
    "native-server": {
      "command": "npx",
      "args": ["my-mcp-server"]
    }
  },
  "openApiServers": {
    "petstore": {
      "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
      "baseUrl": "https://petstore3.swagger.io/api/v3"
    }
  }
}
```

All tools are aggregated together:
- `native-server` tools from MCP protocol
- `petstore` tools auto-generated from OpenAPI spec

## Per-Server Filtering

Apply different filtering rules to each server:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "allowedToolsGlob": ["read_*", "list_*"],  // Read-only
      "denyTools": ["delete_file", "write_file"]
    },
    "github": {
      "command": "...",
      "denyToolsGlob": ["*_delete", "*_remove"]  // No destructive ops
    },
    "database": {
      "url": "...",
      "allowedTools": ["query"]  // Only SELECT queries
    }
  }
}
```

## Capability Caching

Discovered capabilities are cached in memory:

```
┌─────────────────────────────────────────┐
│            Capability Cache              │
├─────────────────────────────────────────┤
│ Tools:     Map<name, {tool, serverName}>│
│ Resources: Map<uri, {resource, server}> │
│ Prompts:   Map<name, {prompt, server}>  │
└─────────────────────────────────────────┘
```

This enables:
- Fast `tools/list` responses (no upstream calls)
- Accurate routing without re-discovery
- Offline capability queries

## Health and Status

Check aggregated status:

```bash
routermcp serve -v
```

Output shows:
```
[gateway] Discovered filesystem: 5 tools
[gateway] Discovered github: 12 tools
[gateway] Discovered database: 3 tools
[gateway] Aggregated: 20 tools, 0 resources, 0 prompts
[gateway] Ready - serving on stdio
```

## Best Practices

1. **Use descriptive names** - Server names help identify tool sources
2. **Filter early** - Remove unneeded tools during aggregation
3. **Handle collisions proactively** - Check for name conflicts during setup
4. **Set appropriate timeouts** - Balance resource usage vs latency
5. **Use parallel discovery** - Increase concurrency for many servers

---

**Up**: [Advanced](../advanced/) | **See Also**: [Filtering](../configuration/filtering.md), [Server Configuration](../configuration/servers.md)
