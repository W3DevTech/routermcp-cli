---
title: RouterMCP CLI Documentation
description: Official documentation for RouterMCP CLI - MCP Gateway that aggregates multiple upstream servers
---

# RouterMCP CLI Documentation

RouterMCP is a powerful CLI MCP Gateway that aggregates multiple upstream MCP servers into a single unified interface with comprehensive filtering capabilities.

The local daemon control plane is managed by the CLI, while the browser UI for stats and future peering controls lives at `https://cli.routermcp.com` and is not bundled in the binary.

## Why RouterMCP?

- **Aggregate Multiple Servers**: Combine tools from multiple MCP servers into one endpoint
- **Security & Filtering**: Control which tools/resources/prompts are exposed
- **Code Mode**: Execute JavaScript workflows across all your tools
- **Tool Search Mode**: Intelligent tool discovery with semantic search
- **Daemon Mode**: Share a single gateway across multiple MCP clients
- **Tunnel Support**: Expose your gateway publicly via Cloudflare or ngrok

## Quick Start

```bash
# Install globally
npm install -g routermcp

# Create a config file
routermcp config

# Start the gateway
routermcp
```

## Documentation Sections

### [Getting Started](getting-started/installation.md)
Installation, quick start guide, and your first configuration.

- [Installation](getting-started/installation.md)
- [Quick Start](getting-started/quick-start.md)
- [First Configuration](getting-started/first-config.md)

### [Commands](commands/serve.md)
Complete reference for all CLI commands.

- [serve](commands/serve.md) - Start the MCP gateway in foreground/debug mode
- [connect](commands/connect.md) - Connect to the managed daemon (default)
- [daemon lifecycle](advanced/daemon-mode.md) - Start, inspect, stop, or restart the managed daemon
- [proxy](commands/proxy.md) - Proxy stdio server over HTTP
- [tunnel](commands/tunnel.md) - Expose via public tunnel
- [config](commands/config.md) - Interactive configuration wizard
- [doctor](commands/doctor.md) - Check config and OAuth setup
- [oauth](commands/oauth.md) - Manage OAuth tokens
- [telemetry](commands/telemetry.md) - Control anonymous telemetry

### [Configuration](configuration/overview.md)
Everything about configuring RouterMCP.

- [Overview](configuration/overview.md) - Config file format and location
- [Servers](configuration/servers.md) - MCP server configuration
- [Filtering](configuration/filtering.md) - Tool/resource/prompt filtering
- [Environment Variables](configuration/environment-variables.md) - ${env:VAR} syntax
- [OpenAPI Servers](configuration/openapi-servers.md) - OpenAPI-to-MCP conversion
- [HTTP & Sessions](configuration/http-session.md) - HTTP server and session settings

### [Advanced Topics](advanced/code-mode.md)
Deep dives into advanced features.

- [Code Mode](advanced/code-mode.md) - JavaScript execution sandbox
- [Tool Search Mode](advanced/tool-search.md) - Intelligent tool discovery
- [Daemon Mode](advanced/daemon-mode.md) - Background process sharing
- [Multiple Servers](advanced/multiple-servers.md) - Aggregation strategies
- [Security](advanced/security.md) - Security best practices

### [Guides](guides/troubleshooting.md)
Practical how-to guides.

- [Cursor Migration](guides/cursor-migration.md)
- [Claude Code Migration](guides/claude-code-migration.md)
- [OpenAPI Integration](guides/openapi-integration.md)
- [Troubleshooting](guides/troubleshooting.md)

### [Reference](reference/cli-options.md)
Complete reference documentation.

- [CLI Options](reference/cli-options.md) - All command-line flags
- [Config Schema](reference/config-schema.md) - Full JSONC schema

### [Examples](examples/basic-filesystem.md)
Copy-paste configuration examples.

- [Basic Filesystem](examples/basic-filesystem.md)
- [Multi-Server Gateway](examples/multi-server-gateway.md)
- [Remote HTTP Server](examples/remote-http-server.md)
- [Code Mode Workflows](examples/code-mode-workflows.md)
- [Tool Search Workflows](examples/tool-search-workflows.md)

## Need Help?

- [Troubleshooting Guide](guides/troubleshooting.md)
- [GitHub Issues](https://github.com/W3mirror/routermcp-cli/issues)
