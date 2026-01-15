---
title: Daemon Mode
description: Share gateway processes across multiple clients
---

# Daemon Mode

Daemon Mode allows multiple clients to share a single gateway process, reducing resource usage and startup time.

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
2. **Subsequent clients** connect to the existing daemon via HTTP
3. **Idle shutdown** - daemon exits after configurable idle time when all clients disconnect
4. **Automatic restart** - if daemon crashes, next client restarts it

## Using Daemon Mode

### Connect Command

Use `connect` instead of `serve` for daemon-aware operation:

```bash
# Connect to existing daemon, or start one if needed
routermcp connect

# Force stdio mode (for Claude Code, Cursor, etc.)
routermcp connect --stdio

# Specify config file
routermcp connect --config ./my-config.jsonc

# Enable verbose logging
routermcp connect -v
```

### Daemon Lifecycle

```bash
# Check if daemon is running
routermcp connect --status

# Stop the daemon
routermcp connect --stop

# Force restart
routermcp connect --stop && routermcp connect
```

## Configuration

### Idle Shutdown

The daemon shuts down after all clients disconnect:

```jsonc
{
  "daemon": {
    "idle_shutdown": 10  // Seconds to wait (default: 10)
  }
}
```

Set to `0` to disable idle shutdown (daemon runs until manually stopped).

### Port Selection

```jsonc
{
  "daemon": {
    "port": 5151  // Default port
  }
}
```

## File Locations

Daemon state is stored per-project:

```
~/.routermcp/
└── projects/
    └── <project-id>/
        ├── config.jsonc    # Project config (optional)
        ├── daemon.pid      # Process ID
        ├── daemon.port     # HTTP port
        └── daemon.socket   # Unix socket (Linux/macOS)
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

When using `connect --stdio`, the client bridges stdio to HTTP:

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

## Connection Tracking

The daemon tracks active connections:

```
┌─────────────────────────────────────────┐
│                 Daemon                  │
│                                         │
│  Connections: [client-1, client-2]      │
│  Idle Timer:  (not running)             │
│                                         │
└─────────────────────────────────────────┘
         When all disconnect:
┌─────────────────────────────────────────┐
│                 Daemon                  │
│                                         │
│  Connections: []                        │
│  Idle Timer:  10s remaining...          │
│                                         │
└─────────────────────────────────────────┘
```

## Use Cases

### Multiple Editor Instances

Share tools across VS Code, Cursor, and Claude Code:

```bash
# Terminal 1 (VS Code)
routermcp connect --stdio

# Terminal 2 (Cursor)
routermcp connect --stdio

# Terminal 3 (Claude Code)
routermcp connect --stdio
```

All three connect to the same daemon, sharing upstream connections.

### CI/CD Pipelines

Start daemon at pipeline start, reuse across jobs:

```yaml
jobs:
  setup:
    - run: routermcp connect &  # Start daemon in background

  test-1:
    - run: routermcp connect --stdio < commands.json

  test-2:
    - run: routermcp connect --stdio < commands.json
```

### Long-Running Services

Keep gateway running for API clients:

```jsonc
{
  "daemon": {
    "idle_shutdown": 0  // Never auto-shutdown
  }
}
```

## Troubleshooting

### Daemon Won't Start

```bash
# Check for stale PID file
cat ~/.routermcp/projects/<id>/daemon.pid
ps aux | grep <pid>

# Clean up and restart
rm -rf ~/.routermcp/projects/<id>
routermcp connect
```

### Connection Refused

```bash
# Check daemon status
routermcp connect --status

# Check port availability
lsof -i :5151

# Force restart
routermcp connect --stop
routermcp connect
```

### Wrong Config

The daemon uses the config file that started it. To change:

```bash
routermcp connect --stop
routermcp connect --config ./new-config.jsonc
```

## Platform Notes

### Unix (Linux/macOS)

- Uses Unix domain sockets for local communication
- Socket file: `~/.routermcp/projects/<id>/daemon.socket`
- Falls back to HTTP port if socket unavailable

### Windows

- Uses HTTP port only (no Unix sockets)
- Port file: `%USERPROFILE%\.routermcp\projects\<id>\daemon.port`

## Comparison: serve vs connect

| Feature | `serve` | `connect` |
|---------|---------|-----------|
| Process per client | Yes | No (shared) |
| Startup time | Slow | Fast (if running) |
| Resource usage | High | Low |
| Auto-shutdown | No | Yes (configurable) |
| Best for | Single client | Multiple clients |

---

**Up**: [Advanced](../advanced/) | **See Also**: [Connect Command](../commands/connect.md), [Serve Command](../commands/serve.md)
