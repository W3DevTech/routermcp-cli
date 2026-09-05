---
title: OpenAPI Integration
description: Convert REST APIs to MCP tools using OpenAPI specifications
---

# OpenAPI Integration

RouterMCP can automatically convert OpenAPI (Swagger) specifications into MCP tools, allowing AI models to interact with any REST API.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  OpenAPI Spec   │────▶│   RouterMCP     │────▶│   MCP Tools     │
│  (JSON/YAML)    │     │   Converter     │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘

GET /pets          →  get_pets()
POST /pets         →  post_pets({ body })
GET /pets/{id}     →  get_pets_id({ id })
DELETE /pets/{id}  →  delete_pets_id({ id })
```

## Basic Setup

### From URL

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

### From Local File

```jsonc
{
  "openApiServers": {
    "my-api": {
      "spec": "./openapi.yaml",
      "baseUrl": "http://localhost:3000"
    }
  }
}
```

### Inline Spec

```jsonc
{
  "openApiServers": {
    "simple-api": {
      "spec": {
        "openapi": "3.0.0",
        "info": { "title": "Simple API", "version": "1.0" },
        "paths": {
          "/items": {
            "get": {
              "operationId": "listItems",
              "summary": "List all items"
            }
          }
        }
      },
      "baseUrl": "http://localhost:3000"
    }
  }
}
```

## Tool Naming

### With operationId

If the OpenAPI spec includes `operationId`, it becomes the tool name:

```yaml
paths:
  /pets:
    get:
      operationId: listPets  # Tool name: listPets
    post:
      operationId: createPet  # Tool name: createPet
```

### Without operationId

RouterMCP generates names from method and path:

```yaml
paths:
  /pets:
    get:      # Tool name: get_pets
    post:     # Tool name: post_pets
  /pets/{id}:
    get:      # Tool name: get_pets_id
    delete:   # Tool name: delete_pets_id
```

## Authentication

### Bearer Token

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "https://api.example.com/openapi.json",
      "auth": {
        "type": "bearer",
        "token": "${env:API_TOKEN}"
      }
    }
  }
}
```

### API Key

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "https://api.example.com/openapi.json",
      "auth": {
        "type": "api-key",
        "header": "X-API-Key",
        "value": "${env:API_KEY}"
      }
    }
  }
}
```

### Basic Auth

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "https://api.example.com/openapi.json",
      "auth": {
        "type": "basic",
        "username": "${env:API_USER}",
        "password": "${env:API_PASS}"
      }
    }
  }
}
```

## Filtering OpenAPI Tools

Apply the same filtering as MCP tools:

### Allow Specific Operations

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "...",
      "allowedToolsGlob": ["get*", "list*"]  // Only read operations
    }
  }
}
```

### Deny Dangerous Operations

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "...",
      "denyToolsGlob": ["delete*", "*_admin"]  // No delete or admin ops
    }
  }
}
```

### Exact Matching

```jsonc
{
  "openApiServers": {
    "api": {
      "spec": "...",
      "allowedTools": ["listPets", "getPet"],
      "denyTools": ["deletePet"]
    }
  }
}
```

## Combining with MCP Servers

Use OpenAPI alongside native MCP servers:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  },
  "openApiServers": {
    "github-api": {
      "spec": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      "baseUrl": "https://api.github.com",
      "auth": {
        "type": "bearer",
        "token": "${env:GITHUB_TOKEN}"
      },
      "allowedToolsGlob": ["repos*", "issues*"]
    }
  }
}
```

All tools are aggregated together:
- `read_file`, `write_file` from filesystem MCP server
- `repos_get`, `issues_list` from GitHub OpenAPI

## Name Collision Handling

If an OpenAPI tool has the same name as an MCP tool:

```
[gateway] Warning: OpenAPI tool "list_items" collides with MCP tool, skipping
```

The MCP tool takes precedence. Use filtering to resolve:

```jsonc
{
  "mcpServers": {
    "native": {
      "command": "...",
      "denyTools": ["list_items"]  // Use OpenAPI version instead
    }
  },
  "openApiServers": {
    "api": {
      "spec": "..."  // This list_items will be used
    }
  }
}
```

## Spec Caching

OpenAPI specs are cached to avoid re-parsing. Clear the cache:

```bash
routermcp serve --clear
```

Or delete the OpenAPI cache manually (after stopping RouterMCP):

```bash
rm -rf -- ~/.config/routermcp/openapi-cache/
```

## Parameter Mapping

OpenAPI parameters become tool arguments:

```yaml
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: integer
        - name: includeDetails
          in: query
          required: false
          schema:
            type: boolean
```

Becomes:
```typescript
getPet({
  petId: number,       // Required path parameter
  includeDetails?: boolean  // Optional query parameter
})
```

## Request Body

POST/PUT/PATCH bodies are passed as arguments:

```yaml
paths:
  /pets:
    post:
      operationId: createPet
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                tag:
                  type: string
```

Becomes:
```typescript
createPet({
  name: string,
  tag?: string
})
```

## Troubleshooting

### Spec Parsing Errors

1. Validate your OpenAPI spec:
   ```bash
   npx @redocly/cli lint openapi.yaml
   ```

2. Check for unsupported features

### Authentication Failures

1. Check token/credentials are set:
   ```bash
   echo $API_TOKEN
   ```

2. Enable strict env vars to catch missing values:
   ```jsonc
   { "strictEnvVars": true }
   ```

### Missing Tools

1. Check filtering rules
2. Verify spec has operations defined
3. Run with verbose output:
   ```bash
   routermcp serve -v
   ```

### Rate Limiting

Add appropriate delays or use rate limiting on API side.

## Example: GitHub API

Complete example using GitHub's REST API:

```jsonc
{
  "strictEnvVars": true,
  "openApiServers": {
    "github": {
      "spec": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      "baseUrl": "https://api.github.com",
      "auth": {
        "type": "bearer",
        "token": "${env:GITHUB_TOKEN}"
      },
      "allowedToolsGlob": [
        "repos*",
        "issues*",
        "pulls*"
      ],
      "denyToolsGlob": [
        "*delete*",
        "*remove*",
        "*destroy*"
      ]
    }
  }
}
```

---

**Up**: [Guides](../guides/) | **See Also**: [OpenAPI Servers Config](../configuration/openapi-servers.md), [Filtering](../configuration/filtering.md)
