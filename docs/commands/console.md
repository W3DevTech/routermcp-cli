---
title: console Command
description: Open the hosted RouterMCP management console
---

# console Command

Open the hosted RouterMCP management console for the current project. The
command starts the managed daemon when necessary, reuses it when it is already
running, and creates a short-lived browser handoff for the local control plane.

The console is hosted at `https://cli.routermcp.com`; its UI is not bundled in
the CLI. The hosted page communicates directly with the daemon on loopback for
the management operations currently supported by the control plane.

## Usage

```bash
# Print a handoff URL
routermcp console

# Print the URL and open it in the default browser
routermcp console --open

# Print the handoff metadata as JSON
routermcp console --json
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--project <path>` | Project directory for daemon lookup (default: current directory) |
| `--host <host>` | Loopback HTTP bind host for a newly started daemon |
| `--port <port>` | Preferred loopback port for a newly started daemon |
| `--open` | Open the hosted console in the default browser |
| `--json` | Print handoff metadata as JSON |
| `-v, --verbose` | Enable verbose daemon logging |

## Handoff security

The CLI uses the daemon's private local bearer token internally to mint a
separate management credential. The private token is never placed in the
handoff URL or returned by the handoff endpoint. The browser credential:

- expires after five minutes by default and can never exceed fifteen minutes;
- authorizes only control-plane routes such as status, metrics, events, and
  restart;
- cannot access `/mcp`, health, or bridge-lease routes; and
- is held only in daemon memory and is discarded when the daemon stops.

The handoff is encoded in the URL fragment (`#rmcp=...`), so it is not sent as
an HTTP request header to the hosted website. Treat the complete URL as a
secret until it expires: anyone who obtains it can use the management scope
for its remaining lifetime. Do not paste it into tickets, shell history, or
chat. Run `routermcp console` again to create a fresh handoff.

## Current scope

The initial console is local-only and management-only. It provides visibility
into daemon status, configured upstreams, sessions, metrics, and events, plus
the ability to request a daemon restart. Device pairing and peering mutations
will be added through a separately scoped pairing protocol in a later phase.

---

**Previous**: [connect](connect.md) | **Next**: [proxy](proxy.md)
