---
title: Security
description: Security best practices for RouterMCP deployments
---

# Security

This guide covers security considerations and best practices for RouterMCP deployments.

## Threat Model

RouterMCP sits between AI clients and MCP servers:

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│    AI    │────▶│  RouterMCP   │────▶│  MCP Server  │
│  Client  │     │   Gateway    │     │  (Upstream)  │
└──────────┘     └──────────────┘     └──────────────┘
     │                  │                    │
     │                  │                    │
   Trust            Security              Trust
  Boundary          Controls            Boundary
```

### Key Risks

| Risk | Description | Mitigation |
|------|-------------|------------|
| Tool abuse | AI calls dangerous tools | Filtering |
| Credential exposure | Secrets in config | Environment variables |
| Network exposure | Gateway accessible externally | Bind to localhost |
| Code injection | Malicious Code Mode scripts | Sandbox isolation |
| Session hijacking | HTTP session takeover | Session timeouts |

## Tool Filtering

The first line of defense is restricting which tools are exposed.

### Deny-First Approach

Block dangerous operations explicitly:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "denyToolsGlob": [
        "delete_*",
        "remove_*",
        "write_*",
        "*_admin",
        "execute_*"
      ]
    }
  }
}
```

### Allow-Only Approach

Only expose explicitly approved tools:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "allowedToolsGlob": ["read_*", "list_*", "search_*"]
    }
  }
}
```

### Combined Approach

Allow categories, deny specific items:

```jsonc
{
  "mcpServers": {
    "database": {
      "command": "...",
      "allowedToolsGlob": ["query_*"],
      "denyTools": ["query_drop_table", "query_truncate"]
    }
  }
}
```

## Credential Management

### Never Hardcode Secrets

Bad:
```jsonc
{
  "mcpServers": {
    "api": {
      "url": "https://api.example.com",
      "headers": {
        "Authorization": "Bearer sk-1234567890"  // NEVER DO THIS
      }
    }
  }
}
```

Good:
```jsonc
{
  "mcpServers": {
    "api": {
      "url": "https://api.example.com",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}"
      }
    }
  }
}
```

### Strict Environment Variables

Fail if required secrets are missing:

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

### Secure Secret Storage

- Use OS keychain where possible
- Store `.env` files outside repository
- Use secret managers in production (Vault, AWS Secrets Manager)

## Network Security

### Bind to Localhost

Default binding is safe:

```jsonc
{
  "httpServer": {
    "host": "127.0.0.1",  // Default - only local access
    "port": 5151
  }
}
```

### External Access

If external access is needed:

```jsonc
{
  "httpServer": {
    "host": "0.0.0.0"  // Accepts from any IP
  }
}
```

Use with:
- Firewall rules
- VPN/private network
- Reverse proxy with authentication
- Tunnel with access controls

### Tunnel Security

When using tunnels for public access:

```bash
# Cloudflare provides some protection
routermcp tunnel --tunnel=cloudflare

# Consider access policies in Cloudflare Zero Trust
```

## Code Mode Security

Code Mode has multiple security layers:

### Sandbox Isolation

Code runs in QuickJS WebAssembly:
- No filesystem access
- No process spawning
- No raw network sockets
- Memory constrained
- Time-limited execution

### Disable Network Access

```jsonc
{
  "codeMode": {
    "enabled": true,
    "allowFetch": false  // No HTTP requests from sandbox
  }
}
```

### Execution Timeout

```jsonc
{
  "codeMode": {
    "timeout": 10000  // 10 second limit
  }
}
```

### Tool Access Control

Code Mode respects all tool filtering:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "allowedToolsGlob": ["read_*"]  // Code Mode can only read
    }
  },
  "codeMode": { "enabled": true }
}
```

## Session Security

### Session Timeouts

```jsonc
{
  "session": {
    "timeout": 300,      // 5 minute idle timeout
    "max_sessions": 25   // Limit concurrent sessions
  }
}
```

### Session ID Requirements

- Sessions are identified by `Mcp-Session-Id` header
- Use cryptographically random session IDs
- Don't expose session IDs in URLs or logs

## Logging and Audit

### Verbose Logging

Enable for debugging (not production):

```bash
routermcp serve -v
```

### Log Sanitization

RouterMCP automatically:
- Hides credentials in logs
- Sanitizes error messages
- Redacts sensitive headers

### Audit Trail

For production, consider:
- Structured logging to SIEM
- Tool call tracking
- Access logging

## Transport Security

### HTTPS for Remote Servers

Always use HTTPS for remote MCP servers:

```jsonc
{
  "mcpServers": {
    "remote": {
      "url": "https://secure.example.com/mcp"  // Not http://
    }
  }
}
```

### Certificate Validation

Node.js validates TLS certificates by default. Don't disable this.

## OAuth Security

When using OAuth for upstream servers:

```jsonc
{
  "mcpServers": {
    "api": {
      "url": "https://api.example.com/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "your-client-id"
        // client_secret should be in environment
      }
    }
  }
}
```

### OAuth Best Practices

1. Use PKCE for public clients
2. Store tokens securely (OS keychain)
3. Implement token refresh
4. Use minimal scopes

## Hosted Console Pairing

The hosted RouterMCP console must not receive the managed daemon's
`localAuthToken`. That token protects the daemon's internal MCP and control
plane and remains private runtime state. Device pairing uses an independent,
short-lived, one-time scoped grant and challenge; a later exchange phase will
mint a separate management credential for the browser.

See the [device-pairing contract](device-pairing.md) for scope, expiry,
revocation, profile/instance binding, and URL-fragment handling requirements.

## Deployment Checklist

### Development

- [ ] Use environment variables for secrets
- [ ] Bind to localhost only
- [ ] Enable verbose logging for debugging

### Staging

- [ ] Test tool filtering rules
- [ ] Verify credential management
- [ ] Test session timeouts
- [ ] Audit tool access patterns

### Production

- [ ] Enable `strictEnvVars`
- [ ] Minimize exposed tools
- [ ] Configure appropriate timeouts
- [ ] Set up monitoring/alerting
- [ ] Document security controls
- [ ] Regular security reviews

## Security Response

If you discover a security issue:

1. **Don't** disclose publicly
2. **Do** report responsibly
3. **Document** the issue and steps to reproduce
4. **Check** for similar patterns in your deployment

---

**Up**: [Advanced](../advanced/) | **See Also**: [Filtering](../configuration/filtering.md), [Code Mode](code-mode.md)
