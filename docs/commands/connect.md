---
title: connect Command
description: Connect to a shared gateway daemon
---

# connect Command

Connect to a shared gateway daemon. Multiple MCP clients can share a single gateway instance.
The daemon is started automatically on the first connection and reused by later
connections for the same project and configuration.

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
- **Session Isolation**: Each bridge receives an isolated MCP session
- **Background Management**: Auto-start and reuse of one managed process

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
4. The daemon remains available for subsequent clients until it is explicitly stopped

## Daemon Files

Daemon state is stored in `~/.routermcp/projects/<project-id>/`:

| File | Description |
|------|-------------|
| `runtime.json` | Atomic, authenticated runtime manifest |
| `daemon.lock` | Per-profile startup/lifecycle lock |
| `daemon.log` | Daemon stderr and startup diagnostics |

Legacy `daemon.pid`, `daemon.port`, and `daemon.sock` files may be cleaned up
when upgrading from an older CLI, but are not used for connection routing.

## Example Workflow

### Terminal 1: First Client

```bash
cd /my/project
routermcp connect -v

# Output (diagnostics are written to stderr):
# Connected to daemon at /my/project (pid: 12345, url: http://127.0.0.1:7858/mcp)
```

### Terminal 2: Second Client

```bash
cd /my/project
routermcp connect -v

# Output:
# Connected to daemon at /my/project (pid: 12345, url: http://127.0.0.1:7858/mcp)
```

Both clients now share the same gateway instance!

## Explicit Daemon Lifecycle

Use the daemon commands when a process should be started or stopped without
opening a stdio bridge:

```bash
routermcp start
routermcp status
routermcp stop
```

## Stopping the Daemon

The managed daemon is persistent. Stop it explicitly when it is no longer
needed:

```bash
routermcp stop
```

The stdio bridge releases its lease and MCP session when the client exits. A
lease heartbeat and expiry protect the daemon from retaining a connection when
a client crashes; releasing a lease does not stop the daemon.

## Troubleshooting

### Stale Daemon Files

If the daemon crashed, the next `connect` or `start` invocation validates the
runtime manifest and replaces stale state:

```bash
# Check the daemon status and manifest
routermcp status --json

# Stop any known instance and start a fresh one
routermcp stop
routermcp start
```

### Port Already in Use

If the preferred port `7858` is occupied, the supervisor automatically selects
the next available loopback port. Inspect the selected endpoint with:

```bash
routermcp status --json
```

> **See Also**: [Daemon Mode Deep Dive](../advanced/daemon-mode.md), [serve Command](serve.md)

---

**Previous**: [serve](serve.md) | **Next**: [proxy](proxy.md)
