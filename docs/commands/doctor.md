---
title: doctor Command
description: Check configuration and authenticate OAuth servers
---

# doctor Command

Validate your configuration and handle OAuth authentication for servers that require it.

## Usage

```bash
routermcp doctor                       # Check default config
routermcp doctor -c ./custom.jsonc     # Check custom config
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |

## What It Checks

1. **Configuration Syntax**
   - Valid JSONC format
   - Required fields present
   - Valid transport types

2. **Server Connectivity**
   - Can connect to each server
   - Commands execute successfully
   - HTTP endpoints respond

3. **OAuth Status**
   - Servers requiring authentication
   - Token expiry status
   - Interactive authentication flow

## Example Output

```
$ routermcp doctor

Checking configuration: ./routermcp.jsonc

Servers:
┌────────────┬───────────┬────────────┬─────────────┐
│ Server     │ Transport │ Status     │ OAuth       │
├────────────┼───────────┼────────────┼─────────────┤
│ filesystem │ stdio     │ ✓ OK       │ N/A         │
│ github     │ http      │ ✓ OK       │ ✓ Valid     │
│ api        │ http      │ ✗ Error    │ ⚠ Expired   │
└────────────┴───────────┴────────────┴─────────────┘

Issues found:
  - api: Connection refused (is the server running?)
  - api: OAuth token expired

? Authenticate with 'api' server? (Y/n)
```

## OAuth Authentication Flow

When a server requires OAuth and tokens are missing or expired:

```
? Authenticate with 'api' server? Yes

Opening browser for authentication...
Visit: https://auth.example.com/oauth/authorize?client_id=...

Waiting for callback...
✓ Authentication successful!
Token saved for 'api' server.
```

Tokens are stored in:
- Linux/macOS: `~/.config/routermcp/oauth/`
- Windows: `%APPDATA%\routermcp\oauth\`

## Common Issues

### Configuration Errors

```
Error: Invalid configuration
  - mcpServers.myserver: Missing required field 'command' or 'url'
```

**Fix**: Ensure each server has either `command` (stdio) or `url` (HTTP).

### Connection Failures

```
✗ filesystem: ENOENT: spawn npx failed
```

**Fix**: Ensure the command exists and is in PATH.

### OAuth Issues

```
⚠ github: OAuth token expired (expired 2 hours ago)
```

**Fix**: Re-authenticate using the interactive prompt or:

```bash
routermcp oauth login github
```

## Use Cases

1. **Before First Run**: Validate new configuration
2. **After Changes**: Verify configuration updates
3. **OAuth Setup**: Authenticate with protected servers
4. **Debugging**: Diagnose connection issues

> **See Also**: [oauth Command](oauth.md), [Troubleshooting](../guides/troubleshooting.md)

---

**Previous**: [config](config.md) | **Next**: [oauth](oauth.md)
