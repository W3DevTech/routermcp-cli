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

The local control plane is exposed on the daemon's loopback endpoint under `/api/v1/*` and is authenticated with a private bearer token stored in the daemon runtime manifest. The daemon issues a separate, short-lived management credential for the hosted console; the private daemon token is never printed or sent to the browser. The hosted UI calls this local API directly from the browser using its explicit CORS policy; it does not proxy through the RouterMCP service or ship inside the CLI. Authenticated daemon CORS permits only the hosted origin (`https://cli.routermcp.com`) and the two exact origins used by the local Next.js app (`http://localhost:7953` and `http://127.0.0.1:7953`); it never reflects arbitrary origins or uses a wildcard. The current API provides runtime snapshots, request metrics, event history, and daemon restart. The [device-pairing contract](device-pairing.md) is defined for a later route/credential phase; peer mutations remain deferred.

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

### Hosted management console

Create a short-lived handoff to the hosted console for the current project and
configuration profile:

```bash
# Print the handoff URL
routermcp console

# Print and open the URL in the default browser
routermcp console --open

# Print handoff metadata as JSON for integrations
routermcp console --json
```

`console` starts the daemon if needed and reuses the existing process on later
runs. The CLI exchanges the daemon's private local token for a separate
management credential through `POST /api/v1/management/handoff`. That grant is
valid for five minutes by default (never more than fifteen minutes), is kept in
daemon memory, and authorizes only control-plane routes. It cannot be used for
MCP traffic, health checks, bridge leases, or another handoff.

The grant is encoded in the URL fragment, which browsers do not send to
`cli.routermcp.com`. Treat the complete URL as sensitive until it expires. The
hosted console is a separately deployed website and no UI assets are included
in the CLI package.

## Configuration

### Port Selection

The supervisor uses a loopback port. When no port is configured, it prefers
`7858`; `--port` or `httpServer.port` can provide a different preferred port.
If the preferred port is occupied, the supervisor automatically advances to
the next available port. The selected port is published in `runtime.json` and
should be read from `status --json`, because it may differ from the preferred
port.

## File Locations

Runtime state is stored per project and configuration profile under the
platform's application-state directory. Configuration files remain under
`~/.config/routermcp`; runtime metadata is kept separately so locks, manifests,
and logs are not mixed with user-edited configuration.

On Linux, the default path is:

```
${XDG_STATE_HOME:-~/.local/state}/routermcp/projects/<project-id>/profiles/<profile-id>/
```

`XDG_STATE_HOME` is honored when set. On macOS, the equivalent base directory
is `~/Library/Application Support/RouterMCP/`; on Windows it is
`%LOCALAPPDATA%\RouterMCP\` (falling back to `AppData\Local\RouterMCP`).

Each profile directory contains:

```
<profile-id>/
├── daemon.log      # Daemon stderr and startup diagnostics
├── daemon.lock     # Per-profile lifecycle lock
└── runtime.json    # Atomic runtime manifest and endpoint metadata
```

The project ID is derived from the resolved project directory. The profile ID
is a stable digest of that project ID and the normalized config-file path, so
two config files in the same project receive independent daemon state.

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

**Up**: [Advanced](../advanced/) | **See Also**: [Connect Command](../commands/connect.md), [Console Command](../commands/console.md), [Serve Command](../commands/serve.md)
