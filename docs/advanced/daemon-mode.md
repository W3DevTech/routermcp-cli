---
title: Daemon Mode
description: Share gateway processes across multiple clients
---

# Daemon Mode

Daemon Mode allows multiple clients to share a single gateway process, reducing resource usage and startup time. The CLI owns the local daemon and its authenticated management API; the browser UI for viewing stats and future peering controls is hosted separately at `https://cli.routermcp.com`.

## Overview

Without daemon mode:
```
Client 1 → Gateway Process 1 → Upstream Servers
Client 2 → Gateway Process 2 → Upstream Servers (duplicate)
Client 3 → Gateway Process 3 → Upstream Servers (duplicate)
```

With daemon mode:
```
Client 1 ─┐
Client 2 ─┼→ Shared Gateway Process → Upstream Servers
Client 3 ─┘
```

## How It Works

1. **First client** starts the gateway as a background daemon
2. **Subsequent clients** connect to the existing daemon via authenticated loopback HTTP
3. **Persistent process** - the daemon remains available until explicitly stopped
4. **Automatic restart** - if the daemon crashes or its health check fails, the next client starts it again

The local control plane is exposed on the daemon's loopback endpoint under `/api/v1/*` and is authenticated with a private bearer token stored in the daemon runtime manifest. The hosted UI calls this local API directly from the browser using its explicit CORS policy; it does not proxy through the RouterMCP service or ship inside the CLI. Authenticated daemon CORS permits only the hosted origin (`https://cli.routermcp.com`) and the two exact origins used by the local Next.js app (`http://localhost:7953` and `http://127.0.0.1:7953`); it never reflects arbitrary origins or uses a wildcard. The current API provides runtime snapshots, request metrics, event history, and daemon restart; peer mutations and device pairing are reserved for later phases.

## Using Daemon Mode

### Connect Command

Use `connect` instead of `serve` for daemon-aware operation:

```bash
# Connect to existing daemon, or start one if needed
routermcp connect

# Specify config file
routermcp connect --config ./my-config.jsonc

# Enable verbose logging
routermcp connect -v
```

### Daemon Lifecycle

```bash
# Check if daemon is running
routermcp status

# Stop the daemon
routermcp stop

# Force restart
routermcp restart
```

## Configuration

### Port Selection

The supervisor prefers loopback port `7858` and automatically advances to the
next available port when it is occupied. The selected port is published in
`runtime.json` and should be read from `status --json`; it is not the
`httpServer.port` used by standalone `serve --http` or `tunnel`.

## File Locations

Daemon state is stored per-project:

```
~/.routermcp/
└── projects/
    └── <project-id>/
        ├── daemon.log      # Daemon stderr and startup diagnostics
        ├── daemon.lock     # Per-profile lifecycle lock
        └── runtime.json    # Atomic runtime manifest and endpoint metadata
```

The project ID is derived from the config file path.

## Connection Flow

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│   Client    │────▶│   Connect    │────▶│  Daemon    │
│  (stdio)    │     │   Command    │     │  Running?  │
└─────────────┘     └──────────────┘     └────────────┘
                                               │
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                    ▼
                    ┌──────────┐         ┌──────────┐         ┌──────────┐
                    │   Yes    │         │    No    │         │  Stale   │
                    │ Connect  │         │  Start   │         │ Cleanup  │
                    │ to HTTP  │         │  Daemon  │         │& Restart │
                    └──────────┘         └──────────┘         └──────────┘
```

## Stdio-to-HTTP Bridge

When using `connect`, the client bridges stdio to HTTP:

```
┌──────────┐      stdio       ┌──────────┐      HTTP       ┌──────────┐
│  Claude  │◀────────────────▶│  Client  │◀───────────────▶│  Daemon  │
│   Code   │  JSON-RPC        │  Bridge  │  JSON-RPC       │ Gateway  │
└──────────┘                  └──────────┘                 └──────────┘
```

The bridge:
- Reads JSON-RPC from stdin
- Forwards to daemon via HTTP
- Writes responses to stdout
- Acquires a short-lived lease and heartbeats it while connected
- Releases the lease and closes the MCP session when stdin closes

## Connection Tracking

The daemon tracks active connections:

```
┌─────────────────────────────────────────┐
│                 Daemon                  │
│                                         │
│  Leases: [client-1, client-2]           │
│  Daemon: persistent                     │
│                                         │
└─────────────────────────────────────────┘
         When a client disconnects:
┌─────────────────────────────────────────┐
│                 Daemon                  │
│                                         │
│  Leases: [client-2]                     │
│  Daemon: still available                │
│                                         │
└─────────────────────────────────────────┘
```

## Use Cases

### Multiple Editor Instances

Share tools across VS Code, Cursor, and Claude Code:

```bash
# Terminal 1 (VS Code)
routermcp connect

# Terminal 2 (Cursor)
routermcp connect

# Terminal 3 (Claude Code)
routermcp connect
```

All three connect to the same daemon, sharing upstream connections.

### CI/CD Pipelines

Start daemon at pipeline start, reuse across jobs:

```yaml
jobs:
  setup:
    - run: routermcp start  # Start or reuse daemon

  test-1:
    - run: routermcp connect < commands.json

  test-2:
    - run: routermcp connect < commands.json
```

### Long-Running Services

Keep the gateway running for API clients with `routermcp start`; stop it with
`routermcp stop` when it is no longer needed.

## Troubleshooting

### Daemon Won't Start

```bash
# Check daemon status and its runtime manifest
routermcp status --json

# Clean up and restart
routermcp stop
routermcp connect
```

### Connection Refused

```bash
# Check daemon status
routermcp status

# Check port availability
lsof -i :7858

# Force restart
routermcp stop
routermcp connect
```

### Wrong Config

The daemon uses the config file that started it. To change:

```bash
routermcp stop
routermcp connect --config ./new-config.jsonc
```

## Platform Notes

### All platforms

- Uses authenticated HTTP on `127.0.0.1` for managed daemon communication
- Endpoint metadata is in `runtime.json`; `mcpUrl` points to `/mcp`
- A random local bearer token is generated per daemon and is not included in
  the public status manifest
- The control surface for stats and future peering controls is hosted at `https://cli.routermcp.com`
- No browser UI is bundled with the CLI binary

## Comparison: serve vs connect

| Feature | `serve` | `connect` |
|---------|---------|-----------|
| Process per client | Yes | No (shared) |
| Startup time | Slow | Fast (if running) |
| Resource usage | High | Low |
| Persistence | Foreground lifetime | Persistent until explicitly stopped |
| Best for | Single client | Multiple clients |

---

**Up**: [Advanced](../advanced/) | **See Also**: [Connect Command](../commands/connect.md), [Serve Command](../commands/serve.md)
