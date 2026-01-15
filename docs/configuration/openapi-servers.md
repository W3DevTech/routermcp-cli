---
title: OpenAPI Servers
description: Convert OpenAPI specs to MCP tools
---

# OpenAPI Servers

RouterMCP can automatically convert OpenAPI specifications into MCP tools, allowing you to use any REST API as MCP tools.

## Basic Configuration

```jsonc
{
  "openApiServers": {
    "petstore": {
      "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
      "baseUrl": "https://petstore3.swagger.io/api/v3"
    }
  }
}
```

## Configuration Options

```jsonc
{
  "openApiServers": {
    "api-name": {
      // Spec location (required)
      "spec": "https://example.com/openapi.json",  // URL or file path

      // Base URL for API calls (optional, from spec if not provided)
      "baseUrl": "https://api.example.com",

      // Authentication (optional)
      "auth": {
        "type": "bearer",
        "token": "${env:API_TOKEN}"
      },

      // Enable/disable (optional)
      "enabled": true,

      // Tool filtering (optional)
      "allowedToolsGlob": ["get*", "list*"],
      "denyToolsGlob": ["delete*"]
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `spec` | string \| object | URL, file path, or inline OpenAPI spec |
| `baseUrl` | string | Override base URL from spec |
| `auth` | object | Authentication configuration |
| `enabled` | boolean | Enable/disable this server |
| `allowedTools` | string[] | Exact tool names to allow |
| `denyTools` | string[] | Exact tool names to deny |
| `allowedToolsGlob` | string[] | Glob patterns to allow |
| `denyToolsGlob` | string[] | Glob patterns to deny |

## Spec Sources

### URL

```jsonc
{
  "spec": "https://api.example.com/openapi.json"
}
```

### Local File

```jsonc
{
  "spec": "./specs/openapi.yaml"
}
```

Supports JSON and YAML formats.

### Inline Object

```jsonc
{
  "spec": {
    "openapi": "3.0.0",
    "info": { "title": "My API", "version": "1.0" },
    "paths": {
      "/items": {
        "get": {
          "operationId": "listItems",
          "summary": "List all items"
        }
      }
    }
  }
}
```

## Authentication

### Bearer Token

```jsonc
{
  "auth": {
    "type": "bearer",
    "token": "${env:API_TOKEN}"
  }
}
```

### API Key

```jsonc
{
  "auth": {
    "type": "api-key",
    "header": "X-API-Key",
    "value": "${env:API_KEY}"
  }
}
```

### Basic Auth

```jsonc
{
  "auth": {
    "type": "basic",
    "username": "${env:API_USER}",
    "password": "${env:API_PASS}"
  }
}
```

## Tool Naming

OpenAPI operations become MCP tools:

- Uses `operationId` as tool name
- Falls back to `{method}_{path}` if no operationId

Example:
```yaml
paths:
  /pets:
    get:
      operationId: listPets  # Tool: listPets
  /pets/{id}:
    get:                      # Tool: get_pets_id (no operationId)
```

## Filtering OpenAPI Tools

Same filtering as MCP servers:

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "https://api.example.com/openapi.json",
      "allowedToolsGlob": ["get*", "list*"],
      "denyToolsGlob": ["delete*", "*Admin"]
    }
  }
}
```

## Caching

OpenAPI specs are cached to avoid re-parsing on every start. Clear the cache with:

```bash
routermcp serve --clear
```

## Complete Example

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  },
  "openApiServers": {
    "github": {
      "spec": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      "baseUrl": "https://api.github.com",
      "auth": {
        "type": "bearer",
        "token": "${env:GITHUB_TOKEN}"
      },
      "allowedToolsGlob": ["repos*", "issues*", "pulls*"],
      "denyToolsGlob": ["*Delete", "*Remove"]
    },
    "petstore": {
      "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
      "enabled": false  // Disabled for now
    }
  }
}
```

## Collision with MCP Tools

If an OpenAPI tool has the same name as an MCP tool, the MCP tool takes precedence and a warning is logged:

```
[gateway] Warning: OpenAPI tool "list_items" collides with MCP tool, skipping
```

> **See Also**: [OpenAPI Integration Guide](../guides/openapi-integration.md), [Filtering](filtering.md)

---

**Previous**: [Environment Variables](environment-variables.md) | **Next**: [HTTP & Sessions](http-session.md)
