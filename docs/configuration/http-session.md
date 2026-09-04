---
title: HTTP & Sessions
description: Configure HTTP server and session management
---

# HTTP & Sessions

Configure the HTTP server and session management for HTTP mode. The managed
daemon binds to loopback and exposes its authenticated MCP endpoint over HTTP;
standalone `serve --http` remains available for foreground/debug use.

## HTTP Server Configuration

```jsonc
{
  "httpServer": {
    "port": 5151,        // Default: 5151
    "host": "127.0.0.1"  // Default: 127.0.0.1
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 5151 | HTTP server port |
| `host` | string | 127.0.0.1 | Host to bind to |

## Session Configuration

```jsonc
{
  "session": {
    "timeout": 300,      // Default: 300 (5 minutes)
    "max_sessions": 25   // Default: 25
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | number | 300 | Session timeout in seconds |
| `max_sessions` | number | 25 | Maximum concurrent sessions |

## How Sessions Work

In HTTP mode, RouterMCP manages virtual sessions:

```
┌──────────────┐     ┌─────────────────┐     ┌────────────┐
│   Client A   │────▶│                 │────▶│ Upstream 1 │
│ (Session 1)  │     │    Gateway      │     │ (Session 1)│
└──────────────┘     │                 │     └────────────┘
                     │  Session        │
┌──────────────┐     │  Manager        │     ┌────────────┐
│   Client B   │────▶│                 │────▶│ Upstream 1 │
│ (Session 2)  │     │                 │     │ (Session 2)│
└──────────────┘     └─────────────────┘     └────────────┘
```

1. Each unique session ID gets isolated upstream connections
2. Sessions track activity and timeout after inactivity
3. When max sessions reached, new sessions are rejected

## Session Lifecycle

1. **Creation**: New session created on first request with new session ID
2. **Activity**: Each request resets the session timeout
3. **Idle Timeout**: Session cleaned up after `timeout` seconds of inactivity
4. **Upstream Disconnection**: Idle upstream connections disconnect after `subprocess_timeout` seconds

The `connect` bridge sends `DELETE /mcp` when its stdio input closes so the
daemon can immediately release that virtual session. If a client crashes before
cleanup, its bridge lease expires after the heartbeat TTL and no longer counts
as an active connection.

## Managed daemon endpoint

The managed daemon publishes `mcpUrl`, `controlUrl`, and a private local bearer
token in its per-profile runtime state. The token protects health, bridge lease,
and MCP requests; it is not included in `status --json` output. Browser-based
management should use a separately designed pairing/control API rather than
reading this private token from the filesystem.

## Upstream Connection Management

Related settings for upstream connections:

```jsonc
{
  "subprocess_timeout": 180,      // Idle upstream disconnect (seconds)
  "discovery_concurrency": 5,     // Parallel discovery connections
  "connection_timeout": 30        // Connection timeout (seconds)
}
```

### Lazy Connection

Upstreams connect on-demand:

1. **Discovery**: Gateway connects to all upstreams at startup
2. **Disconnect**: After discovering tools, upstreams are disconnected
3. **On-Demand**: When a tool is called, the upstream reconnects
4. **Idle Timeout**: After `subprocess_timeout` seconds idle, disconnects again

This saves resources when upstreams aren't actively used.

## Examples

### High-Traffic Configuration

For many concurrent clients:

```jsonc
{
  "httpServer": {
    "port": 8080,
    "host": "0.0.0.0"  // Accept from any IP
  },
  "session": {
    "timeout": 600,      // 10 minutes
    "max_sessions": 100  // More concurrent sessions
  },
  "subprocess_timeout": 60  // Faster cleanup
}
```

### Long-Running Sessions

For long-running operations:

```jsonc
{
  "session": {
    "timeout": 3600,     // 1 hour
    "max_sessions": 10   // Fewer but longer sessions
  },
  "subprocess_timeout": 300  // Keep upstreams alive longer
}
```

### Development Configuration

```jsonc
{
  "httpServer": {
    "port": 3000
  },
  "session": {
    "timeout": 30,       // Quick timeout for testing
    "max_sessions": 5
  }
}
```

## Binding to All Interfaces

To accept connections from other machines:

```jsonc
{
  "httpServer": {
    "host": "0.0.0.0"
  }
}
```

> **Warning**: Only do this on trusted networks. Consider using a tunnel for public access.

## Using with Tunnel

When using tunnel commands, HTTP settings are automatically applied:

```bash
routermcp tunnel --tunnel=cloudflare
# Uses httpServer.port from config, defaults to 5151
```

Override with CLI:

```bash
routermcp tunnel --port 8080
```

---

**Previous**: [OpenAPI Servers](openapi-servers.md) | **Up**: [Configuration](overview.md)
