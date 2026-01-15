---
title: proxy Command
description: Proxy a stdio MCP server over HTTP
---

# proxy Command

Proxy a single stdio-based MCP server over HTTP. This is useful when you have one MCP server and want to expose it via HTTP without full gateway configuration.

## Usage

```bash
# Basic SSE proxy
routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# Streamable HTTP (stateless)
routermcp proxy --stdio "node server.js" --outputTransport streamableHttp

# Streamable HTTP (stateful with sessions)
routermcp proxy --stdio "python mcp_server.py" --outputTransport streamableHttp --stateful

# Custom port and paths
routermcp proxy --stdio "npx mcp-server" --port 3000 --basePath /api/v1
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--stdio <command>` | (required) | Command to spawn the MCP server |
| `--outputTransport` | `sse` | Output transport: `sse` or `streamableHttp` |
| `-p, --port` | `8000` | HTTP server port |
| `--basePath` | `""` | Base path prefix for all endpoints |
| `--ssePath` | `/sse` | SSE endpoint path |
| `--messagePath` | `/message` | Message endpoint path (SSE mode) |
| `--streamableHttpPath` | `/mcp` | Streamable HTTP endpoint path |
| `--stateful` | `false` | Enable stateful sessions (streamableHttp only) |
| `--sessionTimeout` | `60000` | Session timeout in milliseconds |
| `--healthEndpoint` | `/health` | Health check endpoint path |
| `--cors` / `--no-cors` | `true` | Enable/disable CORS |
| `--maxRestarts` | `3` | Max child process restart attempts |
| `-v, --verbose` | `false` | Enable verbose logging |

## Transport Modes

### SSE (Server-Sent Events)

```bash
routermcp proxy --stdio "npx mcp-server"
```

**Endpoints:**
- `GET /sse` - Connect via SSE
- `POST /message` - Send messages

**Characteristics:**
- Legacy but widely supported
- Single child process shared across all connections
- Good for simple setups

### Streamable HTTP (Stateless)

```bash
routermcp proxy --stdio "node server.js" --outputTransport streamableHttp
```

**Endpoint:**
- `POST /mcp` - Send/receive messages

**Characteristics:**
- Each request spawns a new child process
- Process terminates after response
- Best for simple, short-lived operations
- No session state

### Streamable HTTP (Stateful)

```bash
routermcp proxy --stdio "python mcp_server.py" --outputTransport streamableHttp --stateful
```

**Endpoints:**
- `POST /mcp` - Send messages
- `GET /mcp` - SSE notifications
- `DELETE /mcp` - Terminate session

**Characteristics:**
- Sessions persist with dedicated child process
- Supports server-initiated notifications
- Session timeout configurable
- Best for complex, stateful operations

## Examples

### Basic Filesystem Proxy

```bash
routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem /home/user/documents"
```

Connect at: `http://localhost:8000/sse`

### Custom Port and Base Path

```bash
routermcp proxy \
  --stdio "npx mcp-server" \
  --port 3000 \
  --basePath /api/v1
```

Connect at: `http://localhost:3000/api/v1/sse`

### Stateful with Session Timeout

```bash
routermcp proxy \
  --stdio "python my_server.py" \
  --outputTransport streamableHttp \
  --stateful \
  --sessionTimeout 120000
```

Sessions last 2 minutes (120000ms) of inactivity.

### Disable CORS

```bash
routermcp proxy --stdio "npx mcp-server" --no-cors
```

## Health Check

All proxy modes include a health endpoint:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

Customize the path:

```bash
routermcp proxy --stdio "..." --healthEndpoint /healthz
```

## Process Management

- **Auto-restart**: Child process is restarted on crash (up to `--maxRestarts`)
- **Graceful shutdown**: SIGTERM/SIGINT properly propagated to child
- **Verbose logging**: Use `-v` to see child process output

> **See Also**: [serve Command](serve.md) for full gateway mode

---

**Previous**: [connect](connect.md) | **Next**: [tunnel](tunnel.md)
