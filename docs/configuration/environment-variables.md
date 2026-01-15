---
title: Environment Variables
description: Use environment variable substitution in configuration
---

# Environment Variables

RouterMCP supports environment variable substitution anywhere in configuration values.

## Syntax

```jsonc
{
  "mcpServers": {
    "api": {
      "url": "${env:API_URL}",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}",
        "X-Environment": "${env:ENV:-production}"
      }
    }
  }
}
```

## Syntax Reference

| Syntax | Description | If Variable Missing |
|--------|-------------|---------------------|
| `${env:VAR}` | Environment variable | Leaves unexpanded (or error if strict) |
| `${env:VAR:-default}` | With default value | Uses default value |
| `${VAR}` | Legacy syntax (deprecated) | Replaces with empty string |

## Examples

### Basic Substitution

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

With environment:
```bash
export API_URL="https://api.example.com/mcp"
export API_TOKEN="secret-token"
routermcp
```

### Default Values

```jsonc
{
  "httpServer": {
    "port": "${env:PORT:-5151}",
    "host": "${env:HOST:-127.0.0.1}"
  },
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "NODE_ENV": "${env:NODE_ENV:-development}",
        "LOG_LEVEL": "${env:LOG_LEVEL:-info}"
      }
    }
  }
}
```

If `PORT` is not set, uses `5151`. If `NODE_ENV` is not set, uses `development`.

### Empty Default

Use `:-` with nothing after for explicit empty string:

```jsonc
{
  "env": {
    "OPTIONAL_VAR": "${env:OPTIONAL:-}"
  }
}
```

### Nested in Strings

```jsonc
{
  "headers": {
    "Authorization": "Bearer ${env:TOKEN}",
    "X-Env": "Environment: ${env:ENV:-dev}"
  }
}
```

## Strict Mode

By default, missing variables are left unexpanded. Enable strict mode to fail on missing variables:

```jsonc
{
  "strictEnvVars": true,
  "mcpServers": {
    "api": {
      "url": "${env:API_URL}"  // Fails if API_URL not set
    }
  }
}
```

**Error if strict and missing:**
```
Error: Environment variable 'API_URL' is not set and strictEnvVars is enabled
```

## Where Substitution Works

Substitution works in **any string value**:

```jsonc
{
  "mcpServers": {
    "server": {
      "command": "${env:MCP_COMMAND}",
      "args": ["${env:ARG1}", "${env:ARG2}"],
      "env": {
        "KEY": "${env:VALUE}"
      },
      "cwd": "${env:WORKING_DIR}",
      "url": "${env:URL}",
      "headers": {
        "X-Header": "${env:HEADER_VALUE}"
      }
    }
  }
}
```

## Security Considerations

- **Don't commit secrets**: Use environment variables for API keys, tokens, passwords
- **Use strict mode**: Enable `strictEnvVars` in production to catch missing config
- **CI/CD**: Set variables in your deployment pipeline

### Good Practice

```jsonc
{
  "strictEnvVars": true,
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

```bash
# .env file (not committed)
API_URL=https://api.example.com/mcp
API_TOKEN=secret-token

# Load and run
source .env
routermcp
```

### Bad Practice

```jsonc
{
  "mcpServers": {
    "api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer secret-token-hardcoded"  // Don't do this!
      }
    }
  }
}
```

## Debugging

Check which variables are being substituted:

```bash
routermcp -v
```

Missing variables show warnings:
```
[config] Warning: Environment variable 'API_TOKEN' not found
```

With strict mode:
```
Error: Environment variable 'API_TOKEN' not found (strictEnvVars enabled)
```

---

**Previous**: [Filtering](filtering.md) | **Next**: [OpenAPI Servers](openapi-servers.md)
