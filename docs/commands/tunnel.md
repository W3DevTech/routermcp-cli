---
title: tunnel Command
description: Expose gateway via public tunnel
---

# tunnel Command

Expose your local MCP gateway via a public tunnel, useful for remote access or sharing with others.

## Usage

```bash
routermcp tunnel                           # Interactive wizard
routermcp tunnel --tunnel=cloudflare       # Use Cloudflare tunnel
routermcp tunnel --tunnel=ngrok            # Use ngrok tunnel
routermcp tunnel --tunnel=standalone       # HTTP only, no tunnel
routermcp tunnel --port 8080               # Custom HTTP port
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `-p, --port <port>` | HTTP server port (default: 5151 or `httpServer.port` from config) |
| `--tunnel=<provider>` | Tunnel provider: `standalone`, `cloudflare`, `ngrok`, `routermcp-cloud` |
| `-v, --verbose` | Enable verbose logging |

## Tunnel Providers

### Standalone (No Tunnel)

```bash
routermcp tunnel --tunnel=standalone
```

Starts the HTTP server only, without a public tunnel. Useful for local network access or when you have your own reverse proxy.

### Cloudflare Tunnel

```bash
routermcp tunnel --tunnel=cloudflare
```

**Prerequisites:**
- `cloudflared` CLI installed

**Installation:**
```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Other: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

**Features:**
- Free, no signup required for quick tunnels
- Secure HTTPS endpoint
- No port forwarding needed

### ngrok

```bash
routermcp tunnel --tunnel=ngrok
```

**Prerequisites:**
- ngrok CLI installed and authenticated

**Installation:**
```bash
# Download from https://ngrok.com/download

# Authenticate (one-time)
ngrok config add-authtoken YOUR_TOKEN
```

**Features:**
- Free tier available
- Inspect traffic via dashboard
- Custom domains (paid)

### RouterMCP Cloud

```bash
routermcp tunnel --tunnel=routermcp-cloud
```

> **Coming Soon**: Managed tunnel service with analytics and access control.

## Output

When a tunnel is established:

```
Starting HTTP server on port 5151...
Starting Cloudflare tunnel...

Tunnel established!
  MCP Gateway URL: https://abc123.trycloudflare.com/mcp
  Use this URL in your MCP client configuration
```

## Configuration

You can set the port in your config file:

```jsonc
{
  "httpServer": {
    "port": 8080
  },
  "mcpServers": {
    // ... your servers
  }
}
```

Then run:

```bash
routermcp tunnel --tunnel=cloudflare
# Uses port 8080 from config
```

## Security Considerations

> **Warning**: Exposing your gateway publicly allows anyone with the URL to access your MCP tools.

**Best Practices:**
- Use filtering to limit exposed tools
- Consider OAuth for HTTP servers (if supported)
- Monitor tunnel access logs
- Shut down tunnels when not needed
- Don't expose sensitive filesystem paths

## Use Cases

1. **Remote Development**: Access your local MCP servers from anywhere
2. **Team Sharing**: Let colleagues test your MCP setup
3. **Demos**: Share temporary access to MCP tools
4. **Testing**: Test MCP clients that require HTTPS

> **See Also**: [serve Command](serve.md), [Security Best Practices](../advanced/security.md)

---

**Previous**: [proxy](proxy.md) | **Next**: [config](config.md)
