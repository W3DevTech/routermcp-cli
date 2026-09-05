---
title: CLI Options Reference
description: Complete reference of all RouterMCP command-line options
---

# CLI Options Reference

Complete reference of all RouterMCP command-line options.

## Usage

```bash
routermcp [command] [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `serve` | Start the MCP gateway in foreground/debug mode |
| `connect` | Connect to the managed gateway daemon (default) |
| `console` | Open the hosted management console with a short-lived handoff |
| `start` | Start or reuse the profile daemon |
| `status` | Show profile daemon status |
| `stop` | Stop the profile daemon |
| `restart` | Restart the profile daemon |
| `proxy` | Proxy a stdio MCP server over HTTP |
| `tunnel` | Expose gateway via tunnel |
| `config` | Interactive configuration wizard |
| `doctor` | Check configuration and OAuth status |
| `oauth` | Manage OAuth authentication |
| `telemetry` | Manage anonymous error reporting |
| `help` | Show help message |

## Global Options

These options work with most commands:

| Option | Alias | Description |
|--------|-------|-------------|
| `--config <path>` | `-c` | Path to config file |
| `--verbose` | `-v` | Enable verbose logging |
| `--help` | `-h` | Show help message |

## serve Command

Start the MCP gateway.

```bash
routermcp serve [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--config <path>` | string | `./routermcp.jsonc` | Path to config file |
| `--stdio` | flag | (default) | Use stdio transport |
| `--http <port>` | number | - | Use HTTP transport on specified port |
| `--daemon-mode` | flag | false | Internal managed-daemon mode |
| `--socket <path>` | string | - | Legacy state path; managed connections use loopback HTTP |
| `--clear` | flag | false | Clear OpenAPI cache before starting |
| `--verbose` | flag | false | Enable verbose logging |

### Examples

```bash
# Default stdio mode
routermcp serve

# HTTP mode on port 3000
routermcp serve --http 3000

# With custom config
routermcp serve --config ./my-config.jsonc

# Clear cache and start
routermcp serve --clear -v
```

## connect Command

Connect to a gateway daemon, starting it if needed.

```bash
routermcp connect [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--config <path>` | string | `./routermcp.jsonc` | Path to config file |
| `--project <path>` | string | `.` | Project directory |
| `--stdio` | flag | true | Use stdio output (accepted for compatibility) |
| `--verbose` | flag | false | Enable verbose logging |

### Examples

```bash
# Connect to daemon (auto-start)
routermcp connect

# Specify project directory
routermcp connect --project /path/to/project

# With verbose output
routermcp connect -v
```

## console Command

Open the hosted management console, starting or reusing the managed daemon for
the selected project and configuration profile.

```bash
routermcp console [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--config <path>` | string | `./routermcp.jsonc` | Path to config file |
| `--project <path>` | string | `.` | Project directory |
| `--host <host>` | string | `127.0.0.1` | Loopback bind host for a newly started daemon |
| `--port <port>` | number | `7858` | Preferred loopback port for a newly started daemon |
| `--open` | flag | false | Open the hosted console in the default browser |
| `--json` | flag | false | Print handoff metadata as JSON |
| `--verbose` | flag | false | Enable verbose logging |

The output URL contains an opaque, short-lived management credential in its
fragment. The fragment is not sent to `cli.routermcp.com`, but the complete URL
must still be treated as sensitive. The credential expires after five minutes
by default (maximum fifteen minutes), is held only in daemon memory, and is
limited to control-plane management routes. It cannot access MCP, health, or
bridge-lease routes. The hosted UI is not included in the CLI package.

## proxy Command

Proxy a single MCP server over HTTP.

```bash
routermcp proxy --stdio "<command>" [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--stdio <command>` | string | (required) | Command to spawn MCP server |
| `--outputTransport <type>` | string | `sse` | Output transport: `sse` or `streamableHttp` |
| `--port <port>` | number | 8000 | HTTP server port |
| `--basePath <path>` | string | `""` | Base path prefix for endpoints |
| `--ssePath <path>` | string | `/sse` | SSE endpoint path |
| `--messagePath <path>` | string | `/message` | Message endpoint for SSE |
| `--streamableHttpPath <path>` | string | `/mcp` | Streamable HTTP endpoint |
| `--stateful` | flag | false | Enable stateful sessions |
| `--sessionTimeout <ms>` | number | 60000 | Session timeout in ms |
| `--healthEndpoint <path>` | string | `/health` | Health check endpoint |
| `--cors` | flag | true | Enable CORS |
| `--no-cors` | flag | false | Disable CORS |
| `--maxRestarts <n>` | number | 3 | Max process restart attempts |
| `--verbose` | flag | false | Enable verbose logging |

### Examples

```bash
# Basic SSE proxy
routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# Streamable HTTP with sessions
routermcp proxy --stdio "node server.js" --outputTransport streamableHttp --stateful

# Custom paths and port
routermcp proxy --stdio "python mcp.py" --basePath /api/v1 --port 3000
```

## tunnel Command

Expose the gateway via a public tunnel.

```bash
routermcp tunnel [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--config <path>` | string | `./routermcp.jsonc` | Path to config file |
| `--tunnel=<provider>` | string | `standalone` | Tunnel provider |
| `--port <port>` | number | 5151 | HTTP server port |
| `--verbose` | flag | false | Enable verbose logging |

### Tunnel Providers

| Provider | Description |
|----------|-------------|
| `standalone` | HTTP server only (no tunnel) |
| `cloudflare` | Cloudflare Quick Tunnel |
| `ngrok` | ngrok tunnel (requires auth) |
| `routermcp-cloud` | RouterMCP Cloud service |

### Examples

```bash
# Start HTTP server only
routermcp tunnel

# With Cloudflare tunnel
routermcp tunnel --tunnel=cloudflare

# With ngrok
NGROK_AUTHTOKEN=xxx routermcp tunnel --tunnel=ngrok

# Custom port
routermcp tunnel --tunnel=cloudflare --port 8080
```

## config Command

Interactive configuration wizard.

```bash
routermcp config
```

No options - runs interactively.

### Actions

- Add a new server
- Migrate from Cursor/Claude Code
- Edit existing server
- Remove a server
- List all servers
- Validate and save
- Save and exit

## doctor Command

Check configuration and authenticate OAuth servers.

```bash
routermcp doctor [options]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--config <path>` | string | `./routermcp.jsonc` | Path to config file |

### Examples

```bash
# Check default config
routermcp doctor

# Check specific config
routermcp doctor --config ./production.jsonc
```

## oauth Command

Manage OAuth authentication.

```bash
routermcp oauth <subcommand> [options]
```

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `status` | Show OAuth status for all servers |
| `login <server>` | Authenticate with a server |
| `logout <server>` | Clear tokens for a server |
| `logout --all` | Clear all OAuth tokens |

### Examples

```bash
# Check status
routermcp oauth status

# Login to server
routermcp oauth login my-api

# Logout from server
routermcp oauth logout my-api

# Clear all tokens
routermcp oauth logout --all
```

## telemetry Command

Manage anonymous error reporting.

```bash
routermcp telemetry [action]
```

### Actions

| Action | Description |
|--------|-------------|
| (none) | Show current status |
| `status` | Show current status |
| `enable` | Enable telemetry |
| `disable` | Disable telemetry |

### Examples

```bash
# Check status
routermcp telemetry

# Enable telemetry
routermcp telemetry enable

# Disable telemetry
routermcp telemetry disable
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NGROK_AUTHTOKEN` | ngrok authentication token |
| `ROUTERMCP_DAEMON` | Internal: indicates daemon process |
| Custom | Any variable referenced via `${env:VAR}` |

---

**Up**: [Reference](../reference/) | **See Also**: [Config Schema](config-schema.md)
