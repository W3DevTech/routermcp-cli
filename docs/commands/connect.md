---
title: connect Command
description: Connect to a shared gateway daemon
---

# connect Command

Connect to a shared gateway daemon. Multiple MCP clients can share a single gateway instance.

## Usage

```bash
routermcp connect                    # Connect (auto-starts daemon if needed)
routermcp connect --project /path    # Connect using specific project directory
routermcp connect -v                 # Verbose logging
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--project <path>` | Project directory for daemon lookup (default: current directory) |
| `-v, --verbose` | Enable verbose logging |

## Why Use Daemon Mode?

- **Resource Sharing**: Multiple clients share one gateway instance
- **Reduced Overhead**: Upstream servers connect once, not per-client
- **Session Persistence**: Sessions survive client disconnections
- **Background Management**: Auto-start and idle shutdown

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Client 1   │────▶│             │────▶│  Upstream 1 │
│ (Claude)    │     │   Gateway   │     └─────────────┘
└─────────────┘     │   Daemon    │     ┌─────────────┐
                    │  (HTTP)     │────▶│  Upstream 2 │
┌─────────────┐     │             │     └─────────────┘
│  Client 2   │────▶│             │
│ (Cursor)    │     └─────────────┘
└─────────────┘
```

1. Run `routermcp connect`
2. If no daemon exists, one is automatically started
3. Your stdio is proxied to the daemon's HTTP endpoint
4. When all clients disconnect, daemon shuts down after 10 seconds idle

## Daemon Files

Daemon state is stored in `~/.routermcp/projects/<project-id>/`:

| File | Description |
|------|-------------|
| `daemon.pid` | Process ID of running daemon |
| `daemon.port` | HTTP port the daemon listens on |
| `daemon.socket` | Unix socket path (non-Windows) |

## Example Workflow

### Terminal 1: First Client

```bash
cd /my/project
routermcp connect -v

# Output:
# [connect] No existing daemon found, starting new daemon...
# [connect] Daemon started on port 5151
# [connect] Connected to daemon
# MCP Gateway ready (stdio mode)
```

### Terminal 2: Second Client

```bash
cd /my/project
routermcp connect -v

# Output:
# [connect] Found existing daemon on port 5151
# [connect] Connected to daemon
# MCP Gateway ready (stdio mode)
```

Both clients now share the same gateway instance!

## Manual Daemon Mode

You can also start the daemon manually:

```bash
# Start daemon explicitly
routermcp serve --daemon-mode --http 5151

# Then connect from another terminal
routermcp connect
```

## Idle Shutdown

The daemon automatically shuts down after **10 seconds** with no active connections. This prevents orphaned processes while allowing brief reconnection windows.

## Troubleshooting

### Stale Daemon Files

If the daemon crashed, stale PID files may exist:

```bash
# Check if daemon is actually running
ps aux | grep routermcp

# If not running, remove stale files
rm -rf ~/.routermcp/projects/<project-id>
```

### Port Already in Use

If port 5151 is occupied:

```jsonc
{
  "httpServer": {
    "port": 5152
  }
}
```

> **See Also**: [Daemon Mode Deep Dive](../advanced/daemon-mode.md), [serve Command](serve.md)

---

**Previous**: [serve](serve.md) | **Next**: [proxy](proxy.md)
