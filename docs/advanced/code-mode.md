---
title: Code Mode
description: Execute JavaScript in a secure sandbox with access to all MCP tools
---

# Code Mode

Code Mode provides a secure JavaScript execution environment with access to all aggregated MCP tools. It enables AI models to write and execute code that orchestrates multiple tool calls.

## Overview

When Code Mode is enabled, RouterMCP exposes two meta-tools:

| Meta-Tool | Description |
|-----------|-------------|
| `routermcp.listTools` | Lists all available tools with TypeScript definitions |
| `routermcp.executeCode` | Executes JavaScript code in a secure sandbox |

## Enabling Code Mode

```jsonc
{
  "codeMode": {
    "enabled": true,
    "timeout": 30000,      // Execution timeout (ms)
    "allowFetch": true     // Allow HTTP requests from sandbox
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | false | Enable Code Mode meta-tools |
| `timeout` | number | 30000 | Execution timeout in milliseconds |
| `allowFetch` | boolean | true | Allow `fetch()` in sandbox |

## How It Works

### 1. Tool Discovery

The AI model first calls `routermcp.listTools` to get TypeScript definitions:

```typescript
// Example output from routermcp.listTools
declare namespace github {
  function create_issue(args: {
    repo: string;
    title: string;
    body?: string;
  }): Promise<{ url: string; number: number }>;

  function list_issues(args: {
    repo: string;
    state?: "open" | "closed" | "all";
  }): Promise<{ issues: Array<{ title: string; number: number }> }>;
}

declare namespace filesystem {
  function read_file(args: { path: string }): Promise<{ content: string }>;
  function write_file(args: { path: string; content: string }): Promise<void>;
}
```

### 2. Code Execution

The model then writes JavaScript code using `routermcp.executeCode`:

```javascript
// Code submitted to routermcp.executeCode
const issues = await github.list_issues({ repo: "owner/repo", state: "open" });

for (const issue of issues.issues) {
  console.log(`#${issue.number}: ${issue.title}`);
}

const content = await filesystem.read_file({ path: "./README.md" });
return { issueCount: issues.issues.length, readmeLength: content.content.length };
```

### 3. Sandbox Execution

Code runs in a QuickJS WebAssembly sandbox:

- **Isolated**: No access to host filesystem or network (except `fetch` if enabled)
- **Time-limited**: Enforced execution timeout
- **Tool access**: Only aggregated MCP tools are available
- **Logging**: `console.log()` output is captured and returned

## Execution Result

The sandbox returns structured results:

```json
{
  "success": true,
  "result": { "issueCount": 5, "readmeLength": 1234 },
  "logs": ["#1: Bug fix needed", "#2: Feature request"],
  "errors": [],
  "toolCalls": [
    {
      "tool": "github.list_issues",
      "args": { "repo": "owner/repo", "state": "open" },
      "duration": 250
    },
    {
      "tool": "filesystem.read_file",
      "args": { "path": "./README.md" },
      "duration": 15
    }
  ],
  "duration": 312
}
```

## Use Cases

### Multi-Tool Orchestration

Execute complex workflows involving multiple tools:

```javascript
// Create issue and update changelog
const issue = await github.create_issue({
  repo: "owner/repo",
  title: "New feature",
  body: "Description here"
});

const changelog = await filesystem.read_file({ path: "CHANGELOG.md" });
const updated = `## ${new Date().toISOString()}\n- Created issue #${issue.number}\n\n${changelog.content}`;
await filesystem.write_file({ path: "CHANGELOG.md", content: updated });

return { issueUrl: issue.url };
```

### Data Transformation

Process and transform data from multiple sources:

```javascript
const users = await database.query({ sql: "SELECT * FROM users LIMIT 100" });
const enriched = [];

for (const user of users.rows) {
  const profile = await api.get_profile({ userId: user.id });
  enriched.push({ ...user, ...profile });
}

return enriched;
```

### Conditional Logic

Execute tools based on runtime conditions:

```javascript
const status = await monitoring.get_status({ service: "api" });

if (status.health === "unhealthy") {
  await slack.send_message({
    channel: "#alerts",
    message: `API unhealthy: ${status.error}`
  });
  await ops.restart_service({ service: "api" });
}

return status;
```

## Security Model

### Sandbox Isolation

- **QuickJS WebAssembly**: Code runs in isolated WebAssembly environment
- **No Node.js APIs**: No `fs`, `child_process`, `net`, etc.
- **No `eval`/`Function`**: Dynamic code execution is blocked
- **Memory limits**: Sandbox has constrained memory

### Network Access

```jsonc
{
  "codeMode": {
    "allowFetch": false  // Disable all network access
  }
}
```

When `allowFetch: true`:
- Only `fetch()` API is available
- DNS resolution happens in sandbox
- No raw socket access

### Tool Access

- Code can only call tools exposed through the gateway
- All tool filtering rules still apply
- Tool calls are logged in the result

## Timeout Handling

```jsonc
{
  "codeMode": {
    "timeout": 60000  // 60 seconds for long-running operations
  }
}
```

If code exceeds the timeout:

```json
{
  "success": false,
  "result": null,
  "errors": ["Execution timeout exceeded"],
  "toolCalls": [...],
  "duration": 60000
}
```

## Filtering with Code Mode

Use tool filtering to restrict what Code Mode can access:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "allowedToolsGlob": ["read_*"],  // Only read operations
      "denyTools": ["delete_file"]
    }
  },
  "codeMode": {
    "enabled": true
  }
}
```

## Best Practices

1. **Set appropriate timeouts** - Longer for batch operations, shorter for interactive use
2. **Disable fetch when not needed** - Reduces attack surface
3. **Use tool filtering** - Restrict Code Mode to safe operations
4. **Monitor tool calls** - Review the `toolCalls` array in responses
5. **Handle errors** - Check `success` and `errors` in results

---

**Up**: [Advanced](../advanced/) | **See Also**: [Filtering](../configuration/filtering.md)
