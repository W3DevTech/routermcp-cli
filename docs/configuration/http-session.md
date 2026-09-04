---
title: HTTP & Sessions
description: Configure HTTP server and session management
---

# HTTP & Sessions

Configure the HTTP server and session management for HTTP mode. The managed
daemon binds to loopback and exposes its authenticated MCP endpoint over HTTP;
standalone `serve --http` remains available for foreground/debug use. The
browser management UI is hosted separately at `https://cli.routermcp.com` and
is not bundled with the CLI.

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
management must not read this private token from the filesystem. Use
`routermcp console` to have the CLI exchange it locally for a separate,
short-lived browser credential.

The local management API is served on loopback under `/api/v1/*` and is
authenticated with the daemon's private token. The hosted console calls these
endpoints directly from the browser; the hosted service does not proxy local
traffic. Current endpoints include:

- `GET /api/v1/health`
- `GET /api/v1/status`
- `GET /api/v1/servers`
- `GET /api/v1/sessions`
- `GET /api/v1/metrics`
- `GET /api/v1/events`
- `POST /api/v1/restart`

The CLI-only handoff endpoint is separate from those management routes:

- `POST /api/v1/management/handoff` — mint a short-lived management credential
  using the private local token

The handoff endpoint requires the private local token and never accepts a
management credential. A management credential can read the control-plane
snapshots and request a restart, but cannot access `/mcp`, health, or bridge
leases. Credentials are kept in daemon memory, expire after five minutes by
default (maximum fifteen minutes), and are discarded when the daemon stops.

Run:

```bash
routermcp console       # print a hosted-console handoff URL
routermcp console --open
```

The URL carries the credential in its `#rmcp=...` fragment. Browsers do not
send fragments to the hosted website, but the complete URL is still sensitive
until it expires and should not be shared or logged.

The servers snapshot includes both configured MCP upstreams and OpenAPI
adapters. OpenAPI entries expose their resolved base URL, tool count, loading
or failure state, and last check timing; authentication configuration and
generated tool details are never returned.

Peer mutations and device pairing are intentionally not exposed in this phase;
they will use a separately reviewed scoped-pairing contract later.

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
# Uses httpServer.port from config; this is separate from the managed daemon's default port
```

Override with CLI:

```bash
routermcp tunnel --port 8080
```

---

**Previous**: [OpenAPI Servers](openapi-servers.md) | **Up**: [Configuration](overview.md)
