<!-- Specific for npmjs, the Github version is at .github/README.md -->
# RouterMCP

A powerful CLI MCP Gateway that aggregates multiple upstream MCP servers into a single unified interface with comprehensive tool/resource/prompt filtering capabilities.

## Installation

### Global Installation

```bash
npm install -g routermcp
```

After global installation, use `routermcp` command directly:

```bash
routermcp --help
```

### Local Installation

```bash
npm install routermcp
```

Use with npx:

```bash
npx routermcp --help
```

Or add to your package.json scripts:

```json
{
  "scripts": {
    "mcp": "routermcp"
  }
}
```

## Quick Start

1. Create a configuration file:

```bash
routermcp config
```

Or manually create `routermcp.jsonc`:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"]
    }
  }
}
```

2. Start the gateway:

```bash
routermcp
```

## Configuration Reference

RouterMCP uses a JSONC (JSON with Comments) configuration file named `routermcp.jsonc` in your project root.

### Root Configuration

```jsonc
{
  // HTTP server configuration (optional)
  "httpServer": {
    "port": 5151,        // Port for HTTP server (default: 5151)
    "host": "127.0.0.1"  // Host to bind to (default: "127.0.0.1")
  },

  // MCP server configurations
  "mcpServers": {
    "server-name": {
      // Server configuration (see below)
    }
  }
}
```

### Server Configuration

Each server in `mcpServers` supports the following options:

#### Transport Configuration

Transport type is **auto-detected** from config keys:
- `command` key → stdio transport
- `url` key → HTTP streamable transport

You can also use explicit `"transport": "stdio"` or `"transport": "http-streamable"`.
For Claude Code compatibility, `"type"` and `"http"` are also accepted.

**Stdio Transport** (for local processes):

```jsonc
{
  "command": "npx",                    // Command to execute (auto-detects stdio)
  "args": ["-y", "package-name"],      // Arguments array
  "env": {                             // Environment variables (optional)
    "KEY": "value",
    "ANOTHER_KEY": "${ENV_VAR}"        // Supports env var substitution
  },
  "cwd": "/working/directory"          // Working directory (optional)
}
```

**HTTP Transport** (for remote servers):

```jsonc
{
  "url": "http://localhost:3000/mcp",  // MCP server URL (auto-detects http)
  "headers": {                          // HTTP headers (optional)
    "Authorization": "Bearer ${TOKEN}",
    "X-Custom-Header": "value"
  }
}
```

#### Server Control

```jsonc
{
  "enabled": true  // Enable/disable server (default: true)
}
```

#### Tool Filtering

Control which tools are exposed from each server:

```jsonc
{
  // Exact tool names to allow
  "allowedTools": ["tool1", "tool2", "read_file"],
  
  // Exact tool names to deny
  "denyTools": ["delete_file", "dangerous_tool"],
  
  // Glob patterns to allow tools
  "allowedToolsGlob": ["read_*", "list_*", "get_*"],
  
  // Glob patterns to deny tools
  "denyToolsGlob": ["delete_*", "remove_*", "*_admin", "*_destroy"]
}
```

#### Resource Filtering

Control which resources are exposed:

```jsonc
{
  // Exact resource URIs to allow
  "allowedResources": ["file:///safe/path", "https://api.example.com/data"],
  
  // Exact resource URIs to deny
  "denyResources": ["file:///secret/path"],
  
  // Glob patterns to allow resources
  "allowedResourcesGlob": ["file:///safe/*", "https://api.example.com/public/*"],
  
  // Glob patterns to deny resources
  "denyResourcesGlob": ["**/secret/**", "file:///private/*"]
}
```

#### Prompt Filtering

Control which prompts are exposed:

```jsonc
{
  // Exact prompt names to allow
  "allowedPrompts": ["commit_message", "pr_description"],
  
  // Exact prompt names to deny
  "denyPrompts": ["admin_prompt", "dangerous_prompt"],
  
  // Glob patterns to allow prompts
  "allowedPromptsGlob": ["safe_*", "public_*"],
  
  // Glob patterns to deny prompts
  "denyPromptsGlob": ["admin_*", "*_secret", "*_private"]
}
```

### Environment Variable Substitution

Use `${VAR_NAME}` syntax anywhere in configuration values:

```jsonc
{
  "mcpServers": {
    "api": {
      "transport": "http-streamable",
      "url": "${API_URL}",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "X-Environment": "${ENV}"
      }
    },
    "local": {
      "transport": "stdio",
      "command": "${NODE_PATH}",
      "args": ["-y", "${MCP_PACKAGE}"],
      "env": {
        "API_KEY": "${SECRET_API_KEY}",
        "PORT": "${PORT:-3000}"  // Default value syntax (if supported)
      }
    }
  }
}
```

## CLI Commands

### Serve (Default)

Start the MCP gateway:

```bash
routermcp                    # Start with stdio transport (default)
routermcp serve              # Explicit serve command
routermcp --http 3000        # Start with HTTP transport on port 3000
routermcp --stdio            # Explicitly use stdio transport
routermcp -c /path/to/config.jsonc  # Use custom config file
routermcp -v                 # Verbose logging
```

### Config Wizard

Interactive configuration wizard:

```bash
routermcp config
```

This will guide you through:
- Adding new servers
- Configuring transport types
- Setting up filtering rules
- Using environment variables

### Tunnel

Expose the gateway via a public tunnel:

```bash
routermcp tunnel                           # Interactive tunnel setup
routermcp tunnel --tunnel=cloudflare       # Use Cloudflare tunnel
routermcp tunnel --tunnel=ngrok            # Use ngrok tunnel
routermcp tunnel --port 8080                # Custom HTTP port
routermcp tunnel --tunnel=cloudflare --port 8080  # Combined options
```

**Available Tunnel Providers:**
- `cloudflare` - Cloudflare Tunnel (via cloudflared)
- `ngrok` - ngrok tunnel
- `routermcp-cloud` - RouterMCP Cloud (coming soon)

### Help

```bash
routermcp --help
routermcp -h
```

## Configuration Examples

### Example 1: Basic Filesystem Server

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"],
      "allowedToolsGlob": ["read_*", "list_*", "search_*"],
      "denyTools": ["write_file", "delete_file"]
    }
  }
}
```

### Example 2: Remote HTTP Server with Authentication

```jsonc
{
  "mcpServers": {
    "remote-api": {
      "transport": "http-streamable",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "X-API-Version": "v1"
      },
      "denyToolsGlob": ["admin_*", "*_delete", "*_destroy"],
      "allowedResourcesGlob": ["https://api.example.com/public/*"]
    }
  }
}
```

### Example 3: Multiple Servers with Different Filters

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/safe/path"],
      "allowedToolsGlob": ["read_*", "list_*"]
    },
    "git": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"],
      "allowedPrompts": ["commit_message", "pr_description"],
      "denyToolsGlob": ["*_force", "*_reset"]
    },
    "database": {
      "transport": "http-streamable",
      "url": "${DB_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${DB_TOKEN}"
      },
      "allowedTools": ["query", "read_table"],
      "denyToolsGlob": ["*_delete", "*_drop", "*_truncate"]
    }
  }
}
```

### Example 4: With HTTP Server Configuration

```jsonc
{
  "httpServer": {
    "port": 8080,
    "host": "0.0.0.0"
  },
  "mcpServers": {
    "local": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

### Example 5: Disabled Server

```jsonc
{
  "mcpServers": {
    "active-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-package"],
      "enabled": true
    },
    "disabled-server": {
      "transport": "stdio",
      "command": "some-command",
      "enabled": false  // This server won't be started
    }
  }
}
```

### Example 6: Complex Filtering

```jsonc
{
  "mcpServers": {
    "restricted": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server"],
      
      // Tools: Allow read operations but deny specific ones
      "allowedToolsGlob": ["read_*", "list_*", "get_*"],
      "denyTools": ["read_secret_file", "read_admin_config"],
      
      // Resources: Only allow safe paths
      "allowedResourcesGlob": ["file:///safe/*", "https://public-api.com/*"],
      "denyResourcesGlob": ["**/secret/**", "**/private/**"],
      
      // Prompts: Allow safe prompts only
      "allowedPromptsGlob": ["safe_*", "public_*"],
      "denyPromptsGlob": ["admin_*", "*_secret"]
    }
  }
}
```

## Filtering Rules

Filter precedence (evaluated in order):

1. **Deny List (Exact)** - If a name exactly matches `denyTools`/`denyResources`/`denyPrompts`, it is denied
2. **Deny Glob** - If a name matches any pattern in `denyToolsGlob`/`denyResourcesGlob`/`denyPromptsGlob`, it is denied
3. **Allow List (Exact)** - If allow lists are defined and name exactly matches, it is allowed
4. **Allow Glob** - If allow globs are defined and name matches a pattern, it is allowed
5. **Default** - If no allow rules are defined, everything is allowed; otherwise, everything else is denied

### Filtering Examples

**Example 1: Allow-only approach**

```jsonc
{
  "allowedToolsGlob": ["read_*", "list_*"]
}
```
Result: Only tools starting with `read_` or `list_` are exposed.

**Example 2: Deny-only approach**

```jsonc
{
  "denyToolsGlob": ["delete_*", "remove_*", "*_admin"]
}
```
Result: All tools except those matching deny patterns are exposed.

**Example 3: Mixed approach**

```jsonc
{
  "allowedToolsGlob": ["read_*"],
  "denyTools": ["read_sensitive_file"]
}
```
Result: Tools starting with `read_` are allowed, except `read_sensitive_file` which is explicitly denied.

**Example 4: No filters**

```jsonc
{
  // No filtering options
}
```
Result: All tools/resources/prompts from the server are exposed.

## Tunnel Configuration

The tunnel command exposes your local MCP gateway via a public URL, useful for remote access or testing.

### Basic Usage

```bash
routermcp tunnel
```

This starts an interactive wizard to select a tunnel provider.

### Cloudflare Tunnel

Requires `cloudflared` to be installed:

```bash
# Install cloudflared (if not already installed)
# macOS: brew install cloudflared
# Linux: Download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

routermcp tunnel --tunnel=cloudflare
```

### ngrok Tunnel

Requires ngrok to be installed and authenticated:

```bash
# Install ngrok (if not already installed)
# https://ngrok.com/download

# Authenticate (one-time setup)
ngrok config add-authtoken YOUR_TOKEN

routermcp tunnel --tunnel=ngrok
```

### Custom Port

```bash
routermcp tunnel --port 8080
```

The port can also be configured in `routermcp.jsonc`:

```jsonc
{
  "httpServer": {
    "port": 8080
  },
  "mcpServers": {
    // ... servers
  }
}
```

### Tunnel Output

When a tunnel is established, you'll see:

```
Tunnel established!
  MCP Gateway URL: https://your-tunnel-url.com/mcp
  Use this URL in your MCP client configuration
```

## Error Handling

### Name Collisions

If multiple upstream servers expose tools/resources/prompts with the same name, the gateway will fail to start with a collision error.

**Resolution:**
- Use filtering to expose only unique names from each server
- Rename tools/resources/prompts at the upstream server level
- Disable conflicting servers if not needed

### Graceful Degradation

If an upstream server fails to connect:
- The gateway continues operating with available servers
- Failed servers are logged with error details
- Their tools/resources/prompts are not exposed
- You can restart the gateway after fixing the server configuration

## CLI Options Reference

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--stdio` | Use stdio transport (default) |
| `--http <port>` | Use HTTP streamable transport on specified port |
| `-v, --verbose` | Enable verbose logging |
| `-h, --help` | Show help message |
| `-p, --port <port>` | HTTP server port (for tunnel command, default: 5151 or httpServer.port) |
| `--tunnel=<provider>` | Tunnel provider: `cloudflare`, `ngrok`, or `routermcp-cloud` |

## Features

- **MCP Gateway**: Expose one MCP server that proxies multiple upstream servers
- **Tool Filtering**: Allow/deny tools per server using exact names or glob patterns
- **Resource Filtering**: Same filtering capabilities for resources
- **Prompt Filtering**: Same filtering capabilities for prompts
- **Multiple Transports**: Support stdio and HTTP streamable for both upstream and gateway
- **Graceful Degradation**: Continue operating if some upstream servers fail
- **Interactive Config**: CLI wizard for creating configuration files
- **Tunnel Support**: Expose gateway via Cloudflare Tunnel or ngrok
- **Environment Variables**: Use `${VAR}` syntax for configuration values

## License

MIT

