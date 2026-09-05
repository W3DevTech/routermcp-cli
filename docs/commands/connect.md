---
title: connect Command
description: Connect to a shared gateway daemon
---

# connect Command

Connect to a shared gateway daemon. Multiple MCP clients can share a single gateway instance.
The daemon is started automatically on the first connection and reused by later
connections on the same machine, including connections from other project
directories and configuration profiles.

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
| `--host <host>` | Loopback bind host for a newly started daemon |
| `--port <port>` | Preferred daemon port (falls back when occupied) |
| `--json` | Print machine-readable daemon status when used with lifecycle commands |
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

The daemon host is machine-wide for the current user. Its process identity,
workspace registry, and durable direct-MCP credential digests are stored in a
platform-specific host directory. Each project/configuration profile also has
runtime metadata below the same state root. On Linux, the defaults are
`~/.local/state/routermcp/host/` and
`~/.local/state/routermcp/projects/<project-id>/profiles/<profile-id>/` (or the
same paths below `XDG_STATE_HOME` when it is set). See [Daemon Mode](../advanced/daemon-mode.md#file-locations) for macOS and Windows paths.

| File | Description |
|------|-------------|
| `runtime.json` | Atomic, authenticated runtime manifest |
| `daemon.lock` | Per-profile startup/lifecycle lock |
| `daemon.log` | Daemon stderr and startup diagnostics |

The host directory additionally contains `runtime.json`, `daemon.lock`,
`workspaces.json`, and `workspace-mcp-credentials.json`. The latter stores only
credential digests and is permissioned for the current user.

Legacy `daemon.pid`, `daemon.port`, and `daemon.sock` files may be cleaned up
when upgrading from an older CLI, but are not used for connection routing.

## Example Workflow

### Terminal 1: First Client

```bash
cd /my/project
routermcp connect -v

# Output (diagnostics are written to stderr):
# Daemon started (pid: 12345, host MCP URL: http://127.0.0.1:7858/mcp)
# Workspace MCP URL: http://127.0.0.1:7858/api/v1/workspaces/<workspace-id>/mcp
```

### Terminal 2: Second Client

```bash
cd /my/project
routermcp connect -v

# Output:
# Connected to daemon (pid: 12345, host MCP URL: http://127.0.0.1:7858/mcp)
# Workspace MCP URL: http://127.0.0.1:7858/api/v1/workspaces/<workspace-id>/mcp
```

Both clients now share the same gateway instance!

`connect` also prints a workspace-bound MCP endpoint on stderr. Use the
explicit `mcp-config` command when an MCP client needs a direct HTTP connection
to this directory:

```bash
routermcp mcp-config
```

The first invocation prints a durable workspace-scoped bearer credential. The
daemon stores only a digest, so subsequent invocations show the endpoint and
metadata without repeating the secret. Use `routermcp mcp-config --rotate` if
the credential is lost or compromised. The endpoint contains an opaque
workspace ID, never the local directory path. The stdio bridge continues to
use the host endpoint internally and remains the recommended default for
clients that support stdio.

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
