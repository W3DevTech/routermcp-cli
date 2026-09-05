---
title: serve Command
description: Start the MCP gateway server
---

# serve Command

Start the MCP gateway in foreground/debug mode. The default `routermcp`
invocation uses [`connect`](connect.md), which starts or reuses a managed
daemon for the current project.

## Usage

```bash
routermcp                           # Connect to the managed daemon (default)
routermcp serve                     # Explicit serve command
routermcp serve --http 3000         # HTTP mode on port 3000
routermcp serve -c /path/to/config.jsonc  # Custom config file
routermcp serve -v                  # Verbose logging
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--stdio` | Use stdio transport (default) |
| `--http <port>` | Use HTTP streamable transport on specified port |
| `--daemon-mode` | Internal managed-daemon mode; normally use `start` or `connect` |
| `--socket <path>` | Legacy state path; managed connections use loopback HTTP |
| `--clear` | Clear OpenAPI cache before starting |
| `-v, --verbose` | Enable verbose logging |

## Transport Modes

### Stdio Mode (Default)

```bash
routermcp serve
```

Uses stdin/stdout for MCP protocol communication. This is the standard mode for MCP clients like Claude Code or Cursor.

### HTTP Mode

```bash
routermcp serve --http 3000
```

Starts an HTTP server on the specified port. Clients connect to `http://localhost:3000/mcp`.

## How It Works

1. **Configuration Loading**: Reads `routermcp.jsonc` (or specified config)
2. **Discovery Phase**: Connects to all upstream servers in parallel to discover tools/resources/prompts
3. **Capability Caching**: Stores discovered capabilities and disconnects from upstreams
4. **Session Manager**: Initializes session management for HTTP multiplexing
5. **Transport Start**: Starts stdio or HTTP transport
6. **On-Demand Connections**: Reconnects to upstreams only when tools are called

## Examples

### Basic Usage

```bash
# Start gateway with verbose output
routermcp serve -v

# Output:
# [upstream] Discovering capabilities from 2 servers (concurrency: 5)
# [upstream] Discovered filesystem: 5 tools, 0 resources, 0 prompts
# [upstream] Discovered git: 8 tools, 0 resources, 2 prompts
# [gateway] Aggregated: 13 tools, 0 resources, 2 prompts
# [gateway] Gateway running
# MCP Gateway ready (stdio mode)
```

### HTTP Mode with Custom Port

```bash
routermcp serve --http 8080 -v
```

### Custom Config Path

```bash
routermcp serve -c ./configs/production.jsonc
```

### Managed Daemon Mode

Use `connect` (or the explicit daemon commands) to start and reuse one
authenticated loopback HTTP process:

```bash
routermcp connect
routermcp start
routermcp status
routermcp stop
```

The CLI stores an atomic runtime manifest per project/configuration profile and
verifies the process identity and authenticated health descriptor before reuse.
The managed bridge always uses TCP/HTTP; Unix socket files are not used.

## Session Management

When running in HTTP mode, RouterMCP manages virtual sessions:

- Each unique session ID gets isolated upstream connections
- Sessions timeout after `session.timeout` seconds (default: 300)
- Maximum concurrent sessions limited by `session.max_sessions` (default: 25)

Configure in `routermcp.jsonc`:

```jsonc
{
  "session": {
    "timeout": 600,      // 10 minutes
    "max_sessions": 50
  }
}
```

> **See Also**: [HTTP & Sessions](../configuration/http-session.md), [Daemon Mode](../advanced/daemon-mode.md)

---

**Next**: [connect](connect.md) | **Up**: [Commands](../index.md)
