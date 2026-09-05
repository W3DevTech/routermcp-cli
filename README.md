<!-- Specific for npmjs, the Github version is at .github/README.md -->
# RouterMCP

A powerful CLI MCP Gateway that aggregates multiple upstream MCP servers into a single unified interface with comprehensive filtering, Code Mode, and session management.

## Installation

```bash
# Global
npm install -g routermcp

# Or use directly with npx
npx routermcp
```

## Quick Start

1. Create `routermcp.jsonc`:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedToolsGlob": ["read_*", "list_*"]
    }
  }
}
```

2. Run the gateway:

```bash
routermcp
```

## Documentation

Full documentation is available in the [docs/](./docs/) folder:

- **Getting Started**
  - [Installation](./docs/getting-started/installation.md)
  - [Quick Start](./docs/getting-started/quick-start.md)
  - [First Configuration](./docs/getting-started/first-config.md)

- **Commands**
  - [serve](./docs/commands/serve.md) - Start the gateway
  - [connect](./docs/commands/connect.md) - Daemon mode
  - [console](./docs/commands/console.md) - Hosted management console
  - [proxy](./docs/commands/proxy.md) - Stdio-to-HTTP proxy
  - [tunnel](./docs/commands/tunnel.md) - Public tunnels
  - [config](./docs/commands/config.md) - Interactive wizard
  - [doctor](./docs/commands/doctor.md) - Config validation
  - [oauth](./docs/commands/oauth.md) - Token management
  - [telemetry](./docs/commands/telemetry.md) - Anonymous reporting

- **Configuration**
  - [Overview](./docs/configuration/overview.md)
  - [Server Configuration](./docs/configuration/servers.md)
  - [Filtering](./docs/configuration/filtering.md)
  - [Environment Variables](./docs/configuration/environment-variables.md)
  - [OpenAPI Servers](./docs/configuration/openapi-servers.md)
  - [HTTP & Sessions](./docs/configuration/http-session.md)

- **Advanced**
  - [Code Mode](./docs/advanced/code-mode.md) - JavaScript sandbox
  - [Daemon Mode](./docs/advanced/daemon-mode.md) - Process sharing
  - [Device Pairing](./docs/advanced/device-pairing.md) - Hosted-console pairing contract
  - [Multiple Servers](./docs/advanced/multiple-servers.md) - Aggregation
  - [Security](./docs/advanced/security.md) - Best practices

- **Reference**
  - [CLI Options](./docs/reference/cli-options.md)
  - [Config Schema](./docs/reference/config-schema.md)

## Features

- **MCP Gateway** - Aggregate multiple MCP servers into one endpoint
- **Tool Filtering** - Allow/deny tools with exact names or glob patterns
- **Code Mode** - Execute JavaScript in a secure sandbox with tool access
- **Session Management** - HTTP multiplexing with isolated sessions
- **Daemon Mode** - Shared gateway process across multiple clients
- **Hosted Management UI** - Browser console for stats and future peering controls at `https://cli.routermcp.com`
- **OpenAPI Integration** - Convert REST APIs to MCP tools
- **Stdio-to-HTTP Proxy** - Expose stdio servers over HTTP
- **Tunnel Support** - Cloudflare and ngrok tunnels for public access
- **Environment Variables** - `${env:VAR}` syntax with defaults

## Client Integration

### Claude Code

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "routermcp": {
      "command": "npx",
      "args": ["-y", "routermcp"]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "routermcp": {
      "command": "npx",
      "args": ["-y", "routermcp"]
    }
  }
}
```

See [Cursor Migration](./docs/guides/cursor-migration.md) and [Claude Code Migration](./docs/guides/claude-code-migration.md) for detailed guides.

## Examples

See the [examples/](./docs/examples/) folder for complete working configurations:

- [Basic Filesystem](./docs/examples/basic-filesystem.md)
- [Multi-Server Gateway](./docs/examples/multi-server-gateway.md)
- [Remote HTTP Server](./docs/examples/remote-http-server.md)
- [Code Mode Workflows](./docs/examples/code-mode-workflows.md)

## Help

```bash
routermcp --help
```

## License

MIT
