---
title: oauth Command
description: Manage OAuth authentication tokens
---

# oauth Command

Manage OAuth tokens for HTTP servers that require authentication.

## Usage

```bash
routermcp oauth status             # Show OAuth status for all servers
routermcp oauth login <server>     # Authenticate with a specific server
routermcp oauth logout <server>    # Clear tokens for a specific server
routermcp oauth logout --all       # Clear all OAuth tokens
```

## Subcommands

### status

Show OAuth status for all configured servers:

```bash
routermcp oauth status
```

Output:
```
OAuth Token Status:
┌────────────┬─────────────┬─────────────────────┬──────────────┐
│ Server     │ Status      │ Expires             │ Scopes       │
├────────────┼─────────────┼─────────────────────┼──────────────┤
│ github     │ ✓ Valid     │ 2024-01-15 14:30:00 │ repo, user   │
│ api        │ ⚠ Expired   │ 2024-01-10 09:00:00 │ read, write  │
│ internal   │ ○ No tokens │ -                   │ -            │
└────────────┴─────────────┴─────────────────────┴──────────────┘
```

### login

Authenticate with a specific server:

```bash
routermcp oauth login github
```

This opens a browser for OAuth authentication:

```
Opening browser for authentication...
Visit: https://github.com/login/oauth/authorize?client_id=...

Waiting for callback...
✓ Authentication successful!
Token saved for 'github' server.
```

### logout

Clear tokens for a specific server:

```bash
routermcp oauth logout github
```

Or clear all tokens:

```bash
routermcp oauth logout --all
```

## Token Storage

OAuth tokens are stored securely:

| Platform | Location |
|----------|----------|
| Linux | `~/.config/routermcp/oauth/<server-url-hash>.json` |
| macOS | `~/.config/routermcp/oauth/<server-url-hash>.json` |
| Windows | `%APPDATA%\routermcp\oauth\<server-url-hash>.json` |

## OAuth Configuration

Configure OAuth in your server config:

```jsonc
{
  "mcpServers": {
    "github": {
      "url": "https://mcp.github.com/api",
      "oauth": {
        "enabled": true,
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "scopes": ["repo", "user"]
      }
    }
  }
}
```

### OAuth Options

| Option | Description |
|--------|-------------|
| `enabled` | Enable/disable OAuth (default: true if oauth config present) |
| `clientId` | OAuth client ID |
| `clientSecret` | OAuth client secret (optional for public clients) |
| `scopes` | Array of OAuth scopes to request |
| `clientName` | Display name for client registration |
| `clientMetadataUrl` | Public HTTPS client metadata URL (defaults to RouterMCP's hosted document) |

RouterMCP uses an explicitly configured `clientId` and optional `clientSecret` first. When no client ID is configured, it uses the configured client metadata URL if the authorization server advertises CIMD support. Other servers use dynamic client registration when available. Configure `clientId` manually when the server supports neither CIMD nor dynamic registration.

The default metadata document identifies RouterMCP as a native client and declares `http://127.0.0.1/oauth/callback`. At login, the CLI binds a free loopback port and sends that actual `127.0.0.1` callback URI through authorization and token exchange. This follows RFC 8252's loopback-port exception without registering a wildcard redirect. Dynamic registrations keep their issuer binding; if discovery later points to another issuer, RouterMCP does not send the old registration or refresh token to it.

Older stored OAuth credentials that have no authorization-server issuer binding cannot be reused for authentication or refresh. Run `routermcp oauth login <server>` to re-authenticate; the CLI discards the unbound credentials and saves the new session with its discovered issuer.

## Token Refresh

RouterMCP automatically:
- Refreshes tokens before they expire
- Prompts for re-authentication if refresh fails
- Logs token status during gateway startup

## Use Cases

1. **Initial Setup**: `routermcp oauth login <server>`
2. **Check Status**: `routermcp oauth status`
3. **Fix Expired**: `routermcp oauth login <server>`
4. **Clean Slate**: `routermcp oauth logout --all`
5. **Switch Accounts**: Logout then login again

## Troubleshooting

### Token Refresh Failed

```
[oauth] Token refresh failed for github: invalid_grant
```

**Fix**: Clear tokens and re-authenticate:

```bash
routermcp oauth logout github
routermcp oauth login github
```

### Browser Didn't Open

If the browser doesn't open automatically, copy the URL from the terminal and paste it manually.

> **See Also**: [doctor Command](doctor.md), [Server Configuration](../configuration/servers.md)

---

**Previous**: [doctor](doctor.md) | **Next**: [telemetry](telemetry.md)
