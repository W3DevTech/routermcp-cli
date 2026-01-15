---
title: config Command
description: Interactive configuration wizard
---

# config Command

Launch an interactive wizard to create or modify your RouterMCP configuration.

## Usage

```bash
routermcp config
```

## What It Does

The config wizard guides you through:

1. **Adding Servers**
   - Choose between stdio or HTTP transport
   - Configure command/URL and arguments
   - Set environment variables

2. **Setting Up Filtering**
   - Select tools to allow or deny
   - Use glob patterns for batch filtering
   - Preview which tools will be exposed

3. **Migration from Other Clients**
   - Import from Cursor MCP config
   - Import from Claude Code MCP config
   - Merge with existing configuration

4. **Configuration Validation**
   - Check syntax before saving
   - Verify server connectivity
   - Identify potential issues

## Interactive Flow

```
$ routermcp config

Welcome to RouterMCP Configuration Wizard!

? What would you like to do?
  ❯ Add a new MCP server
    Import from Cursor config
    Import from Claude Code config
    Edit existing server
    Remove a server
    Save and exit

? Server name: my-server

? Transport type:
  ❯ stdio (local command)
    HTTP (remote server)

? Command to run: npx
? Arguments (comma-separated): -y, @modelcontextprotocol/server-filesystem, .

? Configure tool filtering?
  ❯ No, allow all tools
    Yes, select which tools to allow
    Yes, use glob patterns

Configuration saved to ./routermcp.jsonc
```

## Output

Creates or updates `routermcp.jsonc`:

```jsonc
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## Tips

- Use Tab/arrows to navigate options
- Press Enter to confirm selections
- Press Ctrl+C to cancel and exit
- The wizard validates input before saving

## Migration Examples

### From Cursor

If you have an existing Cursor MCP configuration, the wizard can import it:

```
? Import from Cursor config location: ~/.cursor/mcp.json
Found 3 servers: filesystem, git, database
? Which servers to import?
  ❯ ◉ filesystem
    ◉ git
    ◯ database
```

### From Claude Code

Similarly for Claude Code configurations:

```
? Import from Claude Code config: ~/.mcp.json
Found 2 servers: files, github
Importing all servers...
```

> **See Also**: [First Configuration](../getting-started/first-config.md), [Server Configuration](../configuration/servers.md)

---

**Previous**: [tunnel](tunnel.md) | **Next**: [doctor](doctor.md)
