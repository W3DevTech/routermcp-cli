---
title: Configuration Schema Reference
description: Complete reference of all RouterMCP configuration options
---

# Configuration Schema Reference

Complete reference of all RouterMCP configuration options.

## Config File Format

RouterMCP uses JSONC (JSON with Comments) format:

```jsonc
{
  // Comments are allowed
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["example-server"]
    }
  }
}
```

Supported file names (searched in order):
- `routermcp.jsonc`
- `routermcp.json`
- `mcp.jsonc`
- `mcp.json`

## Root Configuration

```typescript
interface RouterMcpConfig {
  mcpServers?: Record<string, ServerConfig>;
  openApiServers?: Record<string, OpenApiServerConfig>;
  httpServer?: HttpServerConfig;
  session?: SessionConfig;
  codeMode?: CodeModeConfig;
  subprocess_timeout?: number;
  discovery_concurrency?: number;
  connection_timeout?: number;
  strictEnvVars?: boolean;
}
```

### Root Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mcpServers` | object | - | Map of server name to server config |
| `openApiServers` | object | - | Map of OpenAPI server configs |
| `httpServer` | object | - | HTTP server settings |
| `session` | object | - | Session management settings |
| `codeMode` | object | - | Code Mode settings |
| `subprocess_timeout` | number | 180 | Idle timeout for upstream connections (seconds) |
| `discovery_concurrency` | number | 5 | Parallel discovery connections |
| `connection_timeout` | number | 30 | Connection timeout (seconds) |
| `strictEnvVars` | boolean | false | Fail on missing env vars |

## Server Configuration

### Stdio Transport

```typescript
interface StdioServerConfig {
  transport?: "stdio";  // Auto-detected if "command" present
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // + FilterFields
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | string | (auto) | Set to `"stdio"` (optional) |
| `enabled` | boolean | true | Enable/disable this server |
| `command` | string | (required) | Command to execute |
| `args` | string[] | - | Command arguments |
| `env` | object | - | Environment variables |
| `cwd` | string | - | Working directory |

### HTTP Transport

```typescript
interface HttpServerConfig {
  transport?: "http-streamable";  // Auto-detected if "url" present
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  oauth?: OAuthConfig;
  // + FilterFields
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | string | (auto) | Set to `"http-streamable"` |
| `enabled` | boolean | true | Enable/disable this server |
| `url` | string | (required) | Server URL |
| `headers` | object | - | HTTP headers to include |
| `oauth` | object | - | OAuth configuration |

### OAuth Configuration

```typescript
interface OAuthConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  clientName?: string;
  clientMetadataUrl?: string;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | false | Enable OAuth |
| `clientId` | string | - | OAuth client ID |
| `clientSecret` | string | - | OAuth client secret |
| `scopes` | string[] | - | Requested scopes |
| `clientName` | string | - | Display name for client |
| `clientMetadataUrl` | string | `https://www.routermcp.com/oauth/cli-client-metadata.json` | Public HTTPS client metadata document used for CIMD |

## Filter Fields

All server configs support filtering:

```typescript
interface FilterFields {
  // Tools
  allowedTools?: string[];
  denyTools?: string[];
  allowedToolsGlob?: string[];
  denyToolsGlob?: string[];
  // Resources
  allowedResources?: string[];
  denyResources?: string[];
  allowedResourcesGlob?: string[];
  denyResourcesGlob?: string[];
  // Prompts
  allowedPrompts?: string[];
  denyPrompts?: string[];
  allowedPromptsGlob?: string[];
  denyPromptsGlob?: string[];
}
```

| Option | Type | Description |
|--------|------|-------------|
| `allowedTools` | string[] | Exact tool names to allow |
| `denyTools` | string[] | Exact tool names to deny |
| `allowedToolsGlob` | string[] | Glob patterns to allow |
| `denyToolsGlob` | string[] | Glob patterns to deny |
| `allowedResources` | string[] | Exact resource URIs to allow |
| `denyResources` | string[] | Exact resource URIs to deny |
| `allowedResourcesGlob` | string[] | Glob patterns for resources |
| `denyResourcesGlob` | string[] | Glob patterns to deny resources |
| `allowedPrompts` | string[] | Exact prompt names to allow |
| `denyPrompts` | string[] | Exact prompt names to deny |
| `allowedPromptsGlob` | string[] | Glob patterns for prompts |
| `denyPromptsGlob` | string[] | Glob patterns to deny prompts |

### Filter Precedence

```
1. denyTools/denyResources/denyPrompts (exact) → DENY
2. denyToolsGlob/denyResourcesGlob/denyPromptsGlob → DENY
3. allowedTools/allowedResources/allowedPrompts (exact) → ALLOW
4. allowedToolsGlob/allowedResourcesGlob/allowedPromptsGlob → ALLOW
5. If no allow rules defined → ALLOW
6. Otherwise → DENY
```

## OpenAPI Server Configuration

```typescript
interface OpenApiServerConfig {
  spec: string | object;  // URL, path, or inline spec
  baseUrl?: string;
  auth?: OpenApiAuth;
  enabled?: boolean;
  // + Tool filter fields only
  allowedTools?: string[];
  denyTools?: string[];
  allowedToolsGlob?: string[];
  denyToolsGlob?: string[];
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `spec` | string \| object | (required) | URL, path, or inline OpenAPI spec |
| `baseUrl` | string | (from spec) | Override base URL |
| `auth` | object | - | Authentication config |
| `enabled` | boolean | true | Enable/disable |

### OpenAPI Authentication

```typescript
interface OpenApiAuth {
  type: "bearer" | "api-key" | "basic";
  // For bearer
  token?: string;
  // For api-key
  header?: string;
  value?: string;
  // For basic
  username?: string;
  password?: string;
}
```

#### Bearer Token

```jsonc
{
  "auth": {
    "type": "bearer",
    "token": "${env:API_TOKEN}"
  }
}
```

#### API Key

```jsonc
{
  "auth": {
    "type": "api-key",
    "header": "X-API-Key",
    "value": "${env:API_KEY}"
  }
}
```

#### Basic Auth

```jsonc
{
  "auth": {
    "type": "basic",
    "username": "${env:API_USER}",
    "password": "${env:API_PASS}"
  }
}
```

## HTTP Server Configuration

```typescript
interface HttpServerConfig {
  port?: number;
  host?: string;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 5151 | HTTP server port |
| `host` | string | 127.0.0.1 | Host to bind to |

## Session Configuration

```typescript
interface SessionConfig {
  timeout?: number;
  max_sessions?: number;
}
```

| Option | Type | Default | Range | Description |
|--------|------|---------|-------|-------------|
| `timeout` | number | 300 | 1-86400 | Session timeout (seconds) |
| `max_sessions` | number | 25 | 1-1000 | Max concurrent sessions |

## Code Mode Configuration

```typescript
interface CodeModeConfig {
  enabled?: boolean;
  timeout?: number;
  allowFetch?: boolean;
}
```

| Option | Type | Default | Range | Description |
|--------|------|---------|-------|-------------|
| `enabled` | boolean | false | - | Enable Code Mode |
| `timeout` | number | 30000 | 1000-120000 | Execution timeout (ms) |
| `allowFetch` | boolean | true | - | Allow `fetch()` in sandbox |

## Environment Variable Substitution

Use `${env:VAR}` syntax anywhere in string values:

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

### With Default Value

```jsonc
{
  "url": "${env:API_URL:-http://localhost:3000}"
}
```

### Strict Mode

```jsonc
{
  "strictEnvVars": true  // Fail if vars not found
}
```

## Complete Example

```jsonc
{
  // Fail if env vars missing
  "strictEnvVars": true,

  // MCP servers
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "allowedToolsGlob": ["read_*", "list_*"],
      "denyTools": ["delete_file"]
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}"
      },
      "denyToolsGlob": ["*_admin", "*_delete"]
    }
  },

  // OpenAPI servers
  "openApiServers": {
    "petstore": {
      "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
      "baseUrl": "https://petstore3.swagger.io/api/v3",
      "allowedToolsGlob": ["get*", "list*"]
    }
  },

  // HTTP server settings
  "httpServer": {
    "port": 5151,
    "host": "127.0.0.1"
  },

  // Session settings
  "session": {
    "timeout": 300,
    "max_sessions": 25
  },

  // Code Mode
  "codeMode": {
    "enabled": true,
    "timeout": 30000,
    "allowFetch": false
  },

  // Connection settings
  "subprocess_timeout": 180,
  "discovery_concurrency": 5,
  "connection_timeout": 30
}
```

## Validation

RouterMCP validates configuration at startup. Common errors:

- **No servers configured**: At least one `mcpServers` or `openApiServers` required
- **Invalid URL**: Check URL format for HTTP transports
- **Missing command**: Stdio transport requires `command` field
- **Missing auth fields**: Auth type requires corresponding fields

Run validation manually:

```bash
routermcp doctor
```

---

**Up**: [Reference](../reference/) | **See Also**: [CLI Options](cli-options.md)
