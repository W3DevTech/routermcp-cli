---
title: Troubleshooting
description: Common issues and solutions for RouterMCP
---

# Troubleshooting

This guide covers common issues and their solutions.

## Diagnostic Commands

### Doctor Command

Run the built-in diagnostic tool:

```bash
routermcp doctor
```

This checks:
- Configuration file validity
- Server connectivity
- OAuth token status
- Environment variables

### Verbose Mode

Enable detailed logging:

```bash
routermcp serve -v
```

## Startup Issues

### Config File Not Found

**Error:**
```
Error: No configuration file found
```

**Solutions:**

1. Create a config file:
   ```bash
   routermcp config
   ```

2. Specify config location:
   ```bash
   routermcp serve --config /path/to/routermcp.jsonc
   ```

3. Check search paths:
   - `./routermcp.jsonc`
   - `./routermcp.json`
   - `./mcp.jsonc`
   - `./mcp.json`

### Invalid JSON/JSONC

**Error:**
```
Error: Failed to parse config: Unexpected token
```

**Solutions:**

1. Validate JSON syntax:
   ```bash
   npx jsonlint routermcp.jsonc
   ```

2. Check for:
   - Missing commas
   - Trailing commas (allowed in JSONC, not JSON)
   - Unmatched brackets
   - Invalid escape sequences

### Missing Environment Variable

**Error:**
```
Error: Environment variable 'API_TOKEN' is not set and strictEnvVars is enabled
```

**Solutions:**

1. Set the variable:
   ```bash
   export API_TOKEN="your-token"
   routermcp serve
   ```

2. Use default values:
   ```jsonc
   {
     "url": "${env:API_URL:-http://localhost:3000}"
   }
   ```

3. Disable strict mode (not recommended for production):
   ```jsonc
   {
     "strictEnvVars": false
   }
   ```

## Connection Issues

### Server Connection Failed

**Error:**
```
[upstream] Failed to connect to filesystem: spawn npx ENOENT
```

**Solutions:**

1. Check command exists:
   ```bash
   which npx
   ```

2. Use full path:
   ```jsonc
   {
     "command": "/usr/local/bin/npx",
     "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
   }
   ```

3. Check working directory:
   ```jsonc
   {
     "command": "npx",
     "cwd": "/path/to/working/directory"
   }
   ```

### HTTP Server Unreachable

**Error:**
```
[upstream] Failed to connect to api: fetch failed
```

**Solutions:**

1. Test URL directly:
   ```bash
   curl -v https://api.example.com/mcp
   ```

2. Check network/firewall

3. Verify HTTPS certificate

4. Check timeout settings:
   ```jsonc
   {
     "connection_timeout": 60  // Increase from default 30
   }
   ```

### Authentication Failed

**Error:**
```
[upstream] api: 401 Unauthorized
```

**Solutions:**

1. Verify credentials are correct

2. Check token hasn't expired

3. For OAuth, re-authenticate:
   ```bash
   routermcp oauth login api
   ```

4. Check header format:
   ```jsonc
   {
     "headers": {
       "Authorization": "Bearer ${env:TOKEN}"  // Note: "Bearer " prefix
     }
   }
   ```

## Name Collision

**Error:**
```
Error: Name collision detected: read_file (filesystem, backup)
```

**Cause:** Two servers expose tools with the same name.

**Solutions:**

1. Filter out duplicate:
   ```jsonc
   {
     "mcpServers": {
       "filesystem": { "allowedTools": ["read_file"] },
       "backup": { "denyTools": ["read_file"] }
     }
   }
   ```

2. Disable one server:
   ```jsonc
   {
     "mcpServers": {
       "backup": { "enabled": false }
     }
   }
   ```

## Session Issues

### Session Limit Reached

**Error:**
```
Error: Maximum sessions (25) reached
```

**Solutions:**

1. Increase limit:
   ```jsonc
   {
     "session": {
       "max_sessions": 100
     }
   }
   ```

2. Reduce timeout to free sessions faster:
   ```jsonc
   {
     "session": {
       "timeout": 60  // 1 minute instead of 5
     }
   }
   ```

### Session Timeout

**Error:**
```
Error: Session not found or expired
```

**Solutions:**

1. Increase timeout:
   ```jsonc
   {
     "session": {
       "timeout": 3600  // 1 hour
     }
   }
   ```

2. Client should handle reconnection

## Daemon Issues

### Daemon Won't Start

**Error:**
```
Error: Daemon failed to start within timeout
```

**Solutions:**

1. Check for stale files:
   ```bash
   rm -rf ~/.routermcp/projects/<id>
   routermcp connect
   ```

2. Check port availability:
   ```bash
   lsof -i :5151
   ```

3. Check logs:
   ```bash
   routermcp connect -v
   ```

### Can't Connect to Daemon

**Error:**
```
Error: Connection refused
```

**Solutions:**

1. Check daemon status:
   ```bash
   routermcp connect --status
   ```

2. Restart daemon:
   ```bash
   routermcp connect --stop
   routermcp connect
   ```

3. Check if daemon is using different port

## Code Mode Issues

### Execution Timeout

**Error:**
```
Error: Execution timeout exceeded
```

**Solutions:**

1. Increase timeout:
   ```jsonc
   {
     "codeMode": {
       "timeout": 60000  // 60 seconds
     }
   }
   ```

2. Optimize code to run faster

3. Break into smaller operations

### Tool Not Available

**Error:**
```
Error: Tool not found: filesystem.read_file
```

**Solutions:**

1. Check tool filtering isn't blocking it

2. Verify server is connected:
   ```bash
   routermcp serve -v
   ```

3. Use `routermcp.listTools` to see available tools

## Tunnel Issues

### Cloudflare Tunnel Failed

**Error:**
```
Error: Failed to start cloudflared tunnel
```

**Solutions:**

1. Install cloudflared:
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   # or
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
   ```

2. Check cloudflared works:
   ```bash
   cloudflared --version
   ```

### ngrok Tunnel Failed

**Error:**
```
Error: ngrok authentication failed
```

**Solutions:**

1. Set auth token:
   ```bash
   export NGROK_AUTHTOKEN="your-token"
   routermcp tunnel --tunnel=ngrok
   ```

2. Check ngrok account status

## Performance Issues

### Slow Tool Calls

**Possible causes and solutions:**

1. **Cold start** - Upstream reconnecting after idle
   - Reduce `subprocess_timeout` for frequently used servers
   - Use daemon mode to keep connections warm

2. **Network latency** - Remote HTTP servers
   - Consider using stdio for local tools
   - Check network connectivity

3. **Large responses** - Tools returning too much data
   - Filter or paginate results

### High Memory Usage

**Solutions:**

1. Reduce max sessions:
   ```jsonc
   {
     "session": { "max_sessions": 10 }
   }
   ```

2. Reduce subprocess timeout:
   ```jsonc
   {
     "subprocess_timeout": 60
   }
   ```

3. Disable unused servers

## Getting Help

### Logs

Enable verbose logging and capture output:

```bash
routermcp serve -v 2>&1 | tee routermcp.log
```

### Version Info

Include version when reporting issues:

```bash
routermcp --version
```

### Minimal Reproduction

When reporting bugs:

1. Create minimal config that reproduces issue
2. Include exact error message
3. Include RouterMCP version
4. Include OS and Node/Bun version

---

**Up**: [Guides](../guides/) | **See Also**: [Doctor Command](../commands/doctor.md)
