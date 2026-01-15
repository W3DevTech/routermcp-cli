---
title: Code Mode Workflows
description: Examples of using Code Mode to orchestrate multiple tools
---

# Code Mode Workflows

This example shows how to use Code Mode to orchestrate complex workflows across multiple MCP tools.

## Goal

Enable AI models to write and execute JavaScript code that:
- Calls multiple tools in sequence
- Processes data between tool calls
- Implements conditional logic
- Handles errors gracefully

## Configuration

Create `routermcp.jsonc`:

```jsonc
{
  "strictEnvVars": true,

  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  },

  "codeMode": {
    "enabled": true,
    "timeout": 60000,    // 60 seconds for complex workflows
    "allowFetch": true   // Allow HTTP requests
  }
}
```

## Workflow 1: Sync Issues to Notes

Sync GitHub issues to the memory server:

```javascript
// First, list open issues
const issuesResult = await github.list_issues({
  repo: "owner/repo",
  state: "open"
});
const issues = issuesResult.content[0].text;
const issueList = JSON.parse(issues);

// Get existing notes
const notesResult = await memory.list_notes();
const notes = JSON.parse(notesResult.content[0].text);
const noteTitles = new Set(notes.map(n => n.title));

// Sync new issues
let synced = 0;
for (const issue of issueList) {
  const title = `Issue #${issue.number}: ${issue.title}`;

  if (!noteTitles.has(title)) {
    await memory.create_note({
      title: title,
      content: `Status: ${issue.state}\n\n${issue.body}`
    });
    synced++;
    console.log(`Synced: ${title}`);
  }
}

return { total: issueList.length, synced };
```

## Workflow 2: Code Review Summary

Analyze files and create a summary:

```javascript
// Get list of TypeScript files
const files = await filesystem.list_directory({ path: "./src" });
const fileList = JSON.parse(files.content[0].text);
const tsFiles = fileList.filter(f => f.endsWith('.ts'));

const summary = [];

for (const file of tsFiles.slice(0, 5)) {  // Limit to 5 files
  const content = await filesystem.read_file({ path: `./src/${file}` });
  const text = content.content[0].text;

  // Simple analysis
  const lines = text.split('\n').length;
  const functions = (text.match(/function\s+\w+/g) || []).length;
  const classes = (text.match(/class\s+\w+/g) || []).length;

  summary.push({
    file,
    lines,
    functions,
    classes
  });

  console.log(`Analyzed: ${file} (${lines} lines)`);
}

return summary;
```

## Workflow 3: Conditional Actions

Take actions based on conditions:

```javascript
// Check for critical issues
const issues = await github.list_issues({
  repo: "owner/repo",
  labels: "critical"
});
const criticalIssues = JSON.parse(issues.content[0].text);

if (criticalIssues.length > 0) {
  console.log(`Found ${criticalIssues.length} critical issues!`);

  // Store for tracking
  for (const issue of criticalIssues) {
    await memory.create_note({
      title: `CRITICAL: ${issue.title}`,
      content: JSON.stringify(issue, null, 2)
    });
  }

  return {
    status: "alert",
    count: criticalIssues.length,
    issues: criticalIssues.map(i => i.title)
  };
}

return { status: "ok", message: "No critical issues" };
```

## Workflow 4: Data Aggregation

Combine data from multiple sources:

```javascript
// Gather data from multiple sources
const [configResult, packageResult] = await Promise.all([
  filesystem.read_file({ path: "./routermcp.jsonc" }),
  filesystem.read_file({ path: "./package.json" })
]);

const config = JSON.parse(configResult.content[0].text);
const pkg = JSON.parse(packageResult.content[0].text);

// Build report
const report = {
  project: pkg.name,
  version: pkg.version,
  servers: Object.keys(config.mcpServers || {}),
  openApiServers: Object.keys(config.openApiServers || {}),
  features: {
    codeMode: config.codeMode?.enabled || false,
    strictEnvVars: config.strictEnvVars || false
  }
};

console.log(`Project: ${report.project} v${report.version}`);
console.log(`MCP Servers: ${report.servers.join(', ')}`);

return report;
```

## Workflow 5: With External API

If `allowFetch` is enabled:

```javascript
// Fetch external data
const response = await fetch('https://api.github.com/zen');
const zen = await response.text();

// Store in memory
await memory.create_note({
  title: `GitHub Zen - ${new Date().toISOString()}`,
  content: zen
});

// Also save to local file
await filesystem.write_file({
  path: './zen.txt',
  content: zen
});

return { zen };
```

## Discovery: Using routermcp.listTools

Before writing code, discover available tools:

```javascript
// AI model calls routermcp.listTools first
// Returns TypeScript definitions:

declare namespace filesystem {
  function read_file(args: { path: string }): Promise<...>;
  function write_file(args: { path: string; content: string }): Promise<...>;
  function list_directory(args: { path: string }): Promise<...>;
}

declare namespace github {
  function list_issues(args: { repo: string; state?: string }): Promise<...>;
  function create_issue(args: { repo: string; title: string; body?: string }): Promise<...>;
}

declare namespace memory {
  function create_note(args: { title: string; content: string }): Promise<...>;
  function list_notes(): Promise<...>;
}
```

## Execution Result Structure

Code Mode returns detailed results:

```json
{
  "success": true,
  "result": { "synced": 5, "total": 10 },
  "logs": [
    "Synced: Issue #1: Bug fix",
    "Synced: Issue #2: Feature request"
  ],
  "errors": [],
  "toolCalls": [
    {
      "tool": "github.list_issues",
      "args": { "repo": "owner/repo" },
      "duration": 250
    },
    {
      "tool": "memory.create_note",
      "args": { "title": "Issue #1: Bug fix" },
      "duration": 15
    }
  ],
  "duration": 1250
}
```

## Security Considerations

1. **Sandbox Isolation**: Code runs in QuickJS WebAssembly
2. **No Filesystem Access**: Only through MCP tools (which have filtering)
3. **Time Limits**: Execution stops at timeout
4. **Tool Filtering**: Code Mode respects all filter rules

### Restrict Code Mode Access

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "allowedToolsGlob": ["read_*"]  // Code Mode can only read
    }
  },
  "codeMode": {
    "enabled": true,
    "allowFetch": false,    // No external HTTP
    "timeout": 10000        // 10 second limit
  }
}
```

---

**Previous**: [Remote HTTP Server](remote-http-server.md) | **Up**: [Examples](../examples/)
