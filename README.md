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

  // Session configuration for HTTP multiplexing (optional)
  "session": {
    "timeout": 300,      // Session timeout in seconds (default: 300)
    "max_sessions": 25   // Maximum concurrent sessions (default: 25)
  },

  // Code Mode configuration (optional)
  "codeMode": {
    "enabled": true,       // Enable Code Mode (default: false)
    "timeout": 30000,      // Execution timeout in ms (default: 30000)
    "allowFetch": true     // Allow fetch() in sandbox (default: true)
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
    "ANOTHER_KEY": "${env:ENV_VAR}"    // Supports env var substitution
  },
  "cwd": "/working/directory"          // Working directory (optional)
}
```

**HTTP Transport** (for remote servers):

```jsonc
{
  "url": "http://localhost:3000/mcp",  // MCP server URL (auto-detects http)
  "headers": {                          // HTTP headers (optional)
    "Authorization": "Bearer ${env:TOKEN}",
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

Use `${env:VAR_NAME}` syntax anywhere in configuration values:

```jsonc
{
  "strictEnvVars": true,  // Fail if any ${env:...} cannot be resolved (default: false)
  "mcpServers": {
    "api": {
      "transport": "http-streamable",
      "url": "${env:API_URL}",
      "headers": {
        "Authorization": "Bearer ${env:API_TOKEN}",
        "X-Environment": "${env:ENV:-production}"
      }
    },
    "local": {
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "${env:SECRET_API_KEY}",
        "PORT": "${env:PORT:-3000}"
      }
    }
  }
}
```

#### Syntax Reference

| Syntax | Description | If Variable Missing |
|--------|-------------|---------------------|
| `${env:VAR}` | Environment variable | Leaves unexpanded (error if `strictEnvVars: true`) |
| `${env:VAR:-default}` | With default value | Uses default value |
| `${VAR}` | Legacy syntax (deprecated) | Replaces with empty string |

**Examples:**
- `${env:API_KEY}` → Value of `API_KEY` or leaves as `${env:API_KEY}` if missing
- `${env:PORT:-8080}` → Value of `PORT` or `8080` if missing
- `${env:OPTIONAL:-}` → Value of `OPTIONAL` or empty string if missing (explicit empty default)

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

### Connect (Daemon Mode)

Connect to a shared gateway daemon. Multiple MCP clients can share a single gateway instance, which is useful for:
- Reducing resource usage when multiple clients need the same upstream servers
- Sharing session state across multiple client connections
- Background process management with automatic startup and idle shutdown

```bash
routermcp connect                    # Connect to daemon (auto-starts if needed)
routermcp connect --project /path    # Connect using specific project directory
routermcp connect -v                 # Verbose logging
```

**How Daemon Mode Works:**

1. When you run `routermcp connect`, it checks for an existing daemon for the current project
2. If no daemon is running, it automatically starts one in the background
3. The daemon runs an HTTP server on port 5151 (default)
4. The connect command proxies stdio to/from the daemon's HTTP endpoint
5. The daemon automatically shuts down after 10 seconds of idle (no active sessions)

**Daemon Files:**

Daemon state is stored in `~/.routermcp/projects/<project-id>/`:
- `daemon.pid` - Process ID of the running daemon
- `daemon.port` - HTTP port the daemon is listening on

**Manual Daemon Mode:**

You can also run the gateway in daemon mode directly:

```bash
routermcp serve --daemon-mode --http 5151    # Start as daemon on port 5151
routermcp serve --daemon-mode -v             # Daemon with verbose logging
```

### Proxy

Proxy a stdio-based MCP server over HTTP (SSE or Streamable HTTP). This is useful when you have a single MCP server that communicates via stdio and you want to expose it over HTTP without using the full gateway configuration.

```bash
# Basic SSE proxy (default)
routermcp proxy --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# Streamable HTTP proxy (stateless - one process per request)
routermcp proxy --stdio "node server.js" --outputTransport streamableHttp

# Streamable HTTP proxy (stateful - persistent sessions)
routermcp proxy --stdio "python mcp_server.py" --outputTransport streamableHttp --stateful

# With custom port and base path
routermcp proxy --stdio "npx mcp-server" --port 3000 --basePath /api/v1

# With session timeout (stateful mode)
routermcp proxy --stdio "node server.js" --outputTransport streamableHttp --stateful --sessionTimeout 120000
```

**Proxy Options:**

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

**Transport Modes:**

- **SSE (Server-Sent Events)**: Legacy but widely supported. Single child process shared across all connections. Endpoints: `GET /sse` (connect), `POST /message` (send).

- **Streamable HTTP (Stateless)**: Each request spawns a new child process. Best for simple, short-lived operations. Endpoint: `POST /mcp`.

- **Streamable HTTP (Stateful)**: Sessions persist with dedicated child process per session. Supports server-initiated notifications. Endpoints: `POST /mcp` (send), `GET /mcp` (SSE notifications), `DELETE /mcp` (terminate session).

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
        "Authorization": "Bearer ${env:API_TOKEN}",
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
      "url": "${env:DB_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${env:DB_TOKEN}"
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

## Code Mode

Code Mode is an advanced feature that allows LLM clients to execute JavaScript code with access to all configured MCP tools. Instead of exposing raw tools directly, Code Mode exposes two meta-tools that enable programmatic tool orchestration.

### Why Code Mode?

- **Reduced Context Window**: Instead of exposing 100+ tools, expose just 2 meta-tools
- **Complex Workflows**: LLMs can write code that chains multiple tool calls
- **Conditional Logic**: LLMs can implement if/else logic, loops, and error handling
- **Secure Execution**: Code runs in a WebAssembly sandbox (QuickJS) with no filesystem access

### Configuration

```jsonc
{
  "codeMode": {
    "enabled": true,       // Enable Code Mode
    "timeout": 30000,      // Max execution time in ms (default: 30000)
    "allowFetch": true     // Allow fetch() API in sandbox (default: true)
  },
  "mcpServers": {
    // Your MCP servers...
  }
}
```

### Meta-Tools

When Code Mode is enabled, the gateway exposes these tools instead of raw upstream tools:

#### `routermcp.listTools`

Lists all available MCP tools with TypeScript type definitions. Use this to discover what tools are available before writing code.

**Input:**
- `filter` (optional): Filter tools by name or description

**Output:** TypeScript declarations for all available tools

**Example Response:**
```typescript
declare const github: {
  /** Create a new issue */
  create_issue: (args: { owner: string; repo: string; title: string; body?: string }) => Promise<any>;
  /** List repository issues */
  list_issues: (args: { owner: string; repo: string; state?: "open" | "closed" }) => Promise<any>;
};

declare const filesystem: {
  /** Read file contents */
  read_file: (args: { path: string }) => Promise<any>;
};

// Built-in functions:
declare function fetch(url: string, init?: RequestInit): Promise<Response>;
declare const console: { log: (...args: any[]) => void; error: (...args: any[]) => void };
```

#### `routermcp.executeCode`

Executes JavaScript code in a secure sandbox with access to all MCP tools.

**Input:**
- `code` (required): JavaScript code to execute

**Output:** Execution result including:
- `success`: Whether execution completed without errors
- `result`: Return value from the code
- `logs`: Console output (console.log, etc.)
- `errors`: Any errors that occurred
- `toolCalls`: List of MCP tools that were called
- `duration`: Execution time in milliseconds

### Code Mode Examples

**Example 1: Simple tool call**

```javascript
// Call listTools first to see available tools
const issues = await github.list_issues({ owner: "microsoft", repo: "vscode", state: "open" });
console.log(`Found ${issues.length} open issues`);
return issues.slice(0, 5);  // Return first 5
```

**Example 2: Chaining multiple tools**

```javascript
// Read a file and create a GitHub issue with its contents
const content = await filesystem.read_file({ path: "/path/to/bug-report.md" });
const issue = await github.create_issue({
  owner: "myorg",
  repo: "myproject", 
  title: "Bug Report",
  body: content
});
return { issueUrl: issue.html_url };
```

**Example 3: Conditional logic**

```javascript
const issues = await github.list_issues({ owner: "org", repo: "repo", state: "open" });

const criticalIssues = issues.filter(i => i.labels.some(l => l.name === "critical"));

if (criticalIssues.length > 0) {
  console.log(`Found ${criticalIssues.length} critical issues!`);
  return { status: "alert", issues: criticalIssues };
} else {
  return { status: "ok", message: "No critical issues" };
}
```

**Example 4: Using fetch (when allowFetch is enabled)**

```javascript
// Fetch external data and combine with MCP tools
const response = await fetch("https://api.github.com/rate_limit");
const rateLimit = await response.json();

const issues = await github.list_issues({ owner: "org", repo: "repo" });

return {
  rateLimit: rateLimit.rate.remaining,
  issueCount: issues.length
};
```

### Security

Code Mode uses QuickJS compiled to WebAssembly for secure sandboxed execution:

- **No filesystem access**: Code cannot read or write files directly (only via MCP tools)
- **No process access**: Cannot spawn processes or access environment variables
- **Timeout enforcement**: Execution is terminated if it exceeds the configured timeout
- **Network isolation**: `fetch()` can be disabled via `allowFetch: false`
- **Memory limits**: WebAssembly sandbox has built-in memory constraints

### Code Mode vs Direct Tools

| Aspect | Direct Tools | Code Mode |
|--------|-------------|-----------|
| Tools exposed | All configured tools | 2 meta-tools |
| Context window | Large (many tool definitions) | Small (2 tool definitions) |
| Workflow complexity | Single tool calls | Multi-step workflows |
| Error handling | Client-side | In-code try/catch |
| Conditional logic | Not possible | Full JavaScript |
| Best for | Simple operations | Complex orchestration |

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

### Global Options

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Enable verbose logging |
| `-h, --help` | Show help message |

### Serve Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--stdio` | Use stdio transport (default) |
| `--http <port>` | Use HTTP streamable transport on specified port |
| `--daemon-mode` | Run as background daemon (for connect command) |
| `--socket <path>` | Unix socket path (daemon mode, non-Windows) |

### Connect Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `--project <path>` | Project directory for daemon lookup (default: current directory) |

### Proxy Options

| Option | Description |
|--------|-------------|
| `--stdio <command>` | Command to spawn MCP server (required) |
| `--outputTransport <type>` | Output transport: `sse` (default), `streamableHttp` |
| `-p, --port <port>` | HTTP server port (default: 8000) |
| `--basePath <path>` | Base path prefix for all endpoints |
| `--ssePath <path>` | SSE endpoint path (default: `/sse`) |
| `--messagePath <path>` | Message endpoint path for SSE (default: `/message`) |
| `--streamableHttpPath <path>` | Streamable HTTP endpoint (default: `/mcp`) |
| `--stateful` | Enable stateful sessions (streamableHttp only) |
| `--sessionTimeout <ms>` | Session timeout in milliseconds (default: 60000) |
| `--healthEndpoint <path>` | Health check endpoint (default: `/health`) |
| `--cors` / `--no-cors` | Enable/disable CORS (default: enabled) |
| `--maxRestarts <n>` | Max child process restart attempts (default: 3) |

### Tunnel Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file (default: `./routermcp.jsonc`) |
| `-p, --port <port>` | HTTP server port (default: 5151 or httpServer.port) |
| `--tunnel=<provider>` | Tunnel provider: `cloudflare`, `ngrok`, or `routermcp-cloud` |

## Features

- **MCP Gateway**: Expose one MCP server that proxies multiple upstream servers
- **Code Mode**: Execute JavaScript code in a secure WebAssembly sandbox with access to all MCP tools
- **Session Multiplexing**: Multiple HTTP clients can safely share a single gateway with isolated sessions
- **Daemon Mode**: Background gateway process with automatic startup, idle shutdown, and process sharing
- **Stdio-to-HTTP Proxy**: Convert any stdio MCP server to HTTP (SSE or Streamable HTTP)
- **Tool Filtering**: Allow/deny tools per server using exact names or glob patterns
- **Resource Filtering**: Same filtering capabilities for resources
- **Prompt Filtering**: Same filtering capabilities for prompts
- **Multiple Transports**: Support stdio and HTTP streamable for both upstream and gateway
- **Graceful Degradation**: Continue operating if some upstream servers fail
- **Auto-Restart**: Automatic child process restart on failure (configurable attempts)
- **Interactive Config**: CLI wizard for creating configuration files
- **Tunnel Support**: Expose gateway via Cloudflare Tunnel or ngrok
- **Environment Variables**: Use `${env:VAR}` syntax with default value support

## License

MIT

