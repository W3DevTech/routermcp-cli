---
title: serve Command
description: Start the MCP gateway server
---

# serve Command

Start the MCP gateway. This is the default command when you run `routermcp` without arguments.

## Usage

```bash
routermcp                           # Start with defaults (stdio mode)
routermcp serve                     # Explicit serve command
routermcp --http 3000               # HTTP mode on port 3000
routermcp -c /path/to/config.jsonc  # Custom config file
routermcp -v                        # Verbose logging
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--stdio` | Use stdio transport (default) |
| `--http <port>` | Use HTTP streamable transport on specified port |
| `--daemon-mode` | Run as background daemon |
| `--socket <path>` | Unix socket path (daemon mode, non-Windows) |
| `--clear` | Clear OpenAPI cache before starting |
| `-v, --verbose` | Enable verbose logging |

## Transport Modes

### Stdio Mode (Default)

```bash
routermcp
```

Uses stdin/stdout for MCP protocol communication. This is the standard mode for MCP clients like Claude Code or Cursor.

### HTTP Mode

```bash
routermcp --http 3000
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
routermcp -v

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
routermcp --http 8080 -v
```

### Custom Config Path

```bash
routermcp -c ./configs/production.jsonc
```

### Daemon Mode

For running as a background process (used by `connect` command):

```bash
routermcp serve --daemon-mode --http 5151
```

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
