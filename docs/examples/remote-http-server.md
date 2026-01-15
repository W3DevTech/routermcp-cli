---
title: Remote HTTP Server
description: Connect to remote MCP servers via HTTP
---

# Remote HTTP Server

This example shows how to connect to remote MCP servers using HTTP transport.

## Goal

Connect to:
- A remote MCP server with bearer token auth
- An MCP server with OAuth authentication
- Mix remote and local servers

## Basic HTTP Server

Create `routermcp.jsonc`:

```jsonc
{
  "strictEnvVars": true,

  "mcpServers": {
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}",
        "X-API-Version": "v1"
      }
    }
  }
}
```

## OAuth Authentication

For servers requiring OAuth:

```jsonc
{
  "mcpServers": {
    "oauth-server": {
      "url": "https://secure.example.com/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "your-client-id",
        "scopes": ["read", "write"]
      }
    }
  }
}
```

### Authenticate

Run the doctor command to trigger OAuth flow:

```bash
routermcp doctor
```

Or login directly:

```bash
routermcp oauth login oauth-server
```

### Check Token Status

```bash
routermcp oauth status
```

## Mixed Local and Remote

Combine local stdio servers with remote HTTP servers:

```jsonc
{
  "strictEnvVars": true,

  "mcpServers": {
    // Local filesystem
    "local-files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedToolsGlob": ["read_*", "list_*"]
    },

    // Remote API with bearer token
    "cloud-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:CLOUD_API_TOKEN}"
      },
      "denyToolsGlob": ["*_admin", "*_delete"]
    },

    // Another remote server with OAuth
    "enterprise": {
      "url": "https://enterprise.example.com/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "${env:ENTERPRISE_CLIENT_ID}"
      }
    }
  }
}
```

## Exposing Local Server via Tunnel

To make your local gateway accessible remotely:

```bash
# With Cloudflare tunnel
routermcp tunnel --tunnel=cloudflare

# With ngrok
NGROK_AUTHTOKEN=xxx routermcp tunnel --tunnel=ngrok
```

This gives you a public URL like:
```
https://random-words.trycloudflare.com
```

## Proxy Mode

Convert a stdio MCP server to HTTP for remote access:

```bash
# Start as SSE server
routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem ." --port 8080

# Start as Streamable HTTP
routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem ." \
  --outputTransport streamableHttp \
  --port 8080
```

Now accessible at `http://localhost:8080/mcp`.

## Session Management

Configure sessions for HTTP mode:

```jsonc
{
  "httpServer": {
    "port": 5151,
    "host": "0.0.0.0"  // Accept from any IP
  },
  "session": {
    "timeout": 3600,      // 1 hour sessions
    "max_sessions": 100   // Support many clients
  }
}
```

## Connection Timeouts

Configure timeouts for remote servers:

```jsonc
{
  "connection_timeout": 60,     // 60 seconds to connect
  "subprocess_timeout": 300,    // Keep connections alive 5 minutes
  "discovery_concurrency": 3    // Discover 3 servers at a time
}
```

## Error Handling

### Connection Failed

```bash
[upstream] Failed to connect to cloud-api: fetch failed
```

Solutions:
1. Check URL is correct
2. Verify network connectivity
3. Check firewall rules
4. Test with curl: `curl -v https://api.example.com/mcp`

### Authentication Failed

```bash
[upstream] cloud-api: 401 Unauthorized
```

Solutions:
1. Check token is set: `echo $CLOUD_API_TOKEN`
2. Verify token hasn't expired
3. Check header format (Bearer prefix)

### SSL Certificate Error

```bash
[upstream] certificate has expired
```

Solutions:
1. Contact server admin to renew cert
2. For development only: `NODE_TLS_REJECT_UNAUTHORIZED=0` (not recommended)

## Complete Example

```jsonc
{
  "strictEnvVars": true,

  // Remote servers
  "mcpServers": {
    "github-enterprise": {
      "url": "https://github.corp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:GHE_TOKEN}",
        "X-GitHub-Enterprise": "true"
      },
      "denyToolsGlob": ["*_delete", "admin_*"]
    },

    "internal-api": {
      "url": "https://internal.example.com/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "${env:INTERNAL_CLIENT_ID}",
        "scopes": ["api.read", "api.write"]
      }
    }
  },

  // HTTP settings
  "httpServer": {
    "port": 5151,
    "host": "127.0.0.1"
  },

  // Sessions
  "session": {
    "timeout": 1800,
    "max_sessions": 50
  },

  // Timeouts
  "connection_timeout": 30,
  "subprocess_timeout": 300
}
```

---

**Previous**: [Multi-Server Gateway](multi-server-gateway.md) | **Next**: [Code Mode Workflows](code-mode-workflows.md)
