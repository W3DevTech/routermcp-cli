---
title: Tool Search Mode
description: Fuzzy keyword search and execution for MCP tools
---

# Tool Search Mode

Tool Search Mode ranks MCP tools by token matches in their names and descriptions. It supports fuzzy matching for small typos. It does not use semantic embeddings.

## Overview

When Tool Search Mode is enabled, RouterMCP exposes two meta-tools:

| Meta-Tool | Description |
|-----------|-------------|
| `routermcp.searchMcpForTask` | Search and rank tools by task description |
| `routermcp.callTool` | Execute a specific tool by name |

Each candidate's `name` is the exact callable name accepted by `routermcp.callTool`. Candidates also include `originalName` and `serverName` so you can identify the upstream source. When upstream servers expose the same tool name, RouterMCP adds a deterministic suffix to later callable names. Copy `name` exactly; do not build it from the server name.

## Enabling Tool Search Mode

```jsonc
{
  "mcpToolSearch": {
    "enabled": true,
    "description": "Find the best MCP tool for your task",
    "maxResults": 5,
    "minScore": 0.5
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | false | Enable Tool Search meta-tools |
| `description` | string | Auto | Custom description for search tool |
| `maxResults` | number | 5 | Maximum search results to return (1-50) |
| `minScore` | number | 0 | Minimum relevance score threshold (0-1) |

## Mutual Exclusivity

Tool Search Mode and Code Mode cannot both be enabled:

```jsonc
{
  "codeMode": { "enabled": true },     // ❌ Error
  "mcpToolSearch": { "enabled": true }  // ❌ Cannot use both
}
```

Choose one mode based on your use case:
- **Code Mode**: For JavaScript orchestration and complex workflows
- **Tool Search Mode**: For fuzzy keyword search and single-tool execution

## How It Works

### 1. Search for Tools

The AI model first calls `routermcp.searchMcpForTask` with a natural language task description:

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "translate text to french"
  }
}
```

**Response:**

```json
{
  "topTool": "translate",
  "candidates": [
    { "name": "translate", "originalName": "translate", "serverName": "translator", "score": 3.5 },
    { "name": "detect_language", "originalName": "detect_language", "serverName": "translator", "score": 1.0 }
  ],
  "query": "translate text to french",
  "totalTools": 25
}
```

### 2. Execute Tool

The model then calls `routermcp.callTool` with the discovered tool:

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "translate",
    "arguments": {
      "text": "hello world",
      "target_language": "fr"
    }
  }
}
```

**Response:**

```json
{
  "content": [
    { "type": "text", "text": "bonjour le monde" }
  ]
}
```

## Ranking Algorithm

The search uses an enhanced token-based ranking algorithm:

### Scoring Components

1. **Exact Token Matches** (weight: 1.0)
   - Matches between query tokens and tool name/description
   - Example: "translate" matches "translate" exactly

2. **Fuzzy Token Matches** (weight: 0.5)
   - Levenshtein distance ≤ 2 edits
   - Handles typos: "translat" matches "translate"

3. **Phrase Match Bonus** (+0.5)
   - All query tokens appear consecutively
   - Example: "translate text" matches "translate text between languages"

4. **Name Prominence Bonus** (+0.5 per match)
   - Matches in tool names weighted 1.5× higher
   - Example: Tool named "translate" scores higher than description match

### Tokenization

- Handles **camelCase**: `getUserInfo` → `["get", "user", "info"]`
- Handles **snake_case**: `get_user_info` → `["get", "user", "info"]`
- Case-insensitive matching
- Removes special characters

### Example Rankings

**Query:** "weather forecast location"

```json
{
  "candidates": [
    { "name": "get_forecast", "originalName": "get_forecast", "serverName": "weather", "score": 3.5 },
    { "name": "get_current", "originalName": "get_current", "serverName": "location", "score": 1.5 }
  ]
}
```

Tools with no positive score are omitted from `candidates`.

## Configuration Examples

### Basic Configuration

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    },
    "translator": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-translator"]
    }
  },
  "mcpToolSearch": {
    "enabled": true
  }
}
```

### High Precision Mode

Only return highly relevant tools:

```jsonc
{
  "mcpToolSearch": {
    "enabled": true,
    "maxResults": 3,
    "minScore": 2.0  // Require strong matches
  }
}
```

### Custom Description

Provide custom guidance to the AI model:

```jsonc
{
  "mcpToolSearch": {
    "enabled": true,
    "description": "Search available tools by describing your task in natural language. Returns the most relevant tools ranked by relevance score."
  }
}
```

## Use Cases

### Discovery Before Execution

Let the AI discover appropriate tools:

**User:** "I need to check the weather in Paris"

**AI:**
1. Calls `routermcp.searchMcpForTask({ task: "get weather for location" })`
2. Receives `{ topTool: "get_current" }`
3. Calls `routermcp.callTool({ name: "get_current", arguments: { city: "Paris" } })`

### Fuzzy Tool Names

Handle typos and variations:

**Query:** "translat text" (typo)
- Still matches "translate" tool via fuzzy matching

**Query:** "getUserInfo" (camelCase)
- Matches "get_user_info" tool after tokenization

### Tool Exploration

Discover related tools:

**Query:** "git operations"

```json
{
  "candidates": [
    { "name": "commit", "score": 2.0 },
    { "name": "push", "score": 2.0 },
    { "name": "status", "score": 1.5 },
    { "name": "create_issue", "score": 1.0 }
  ]
}
```

## Filtering with Tool Search

Tool filtering applies before search:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "allowedToolsGlob": ["read_*", "list_*"],  // Only read operations
      "denyTools": ["delete_file", "write_file"]
    }
  },
  "mcpToolSearch": {
    "enabled": true
  }
}
```

Search only sees filtered tools:

```json
// Query: "delete file"
{
  "topTool": null,
  "candidates": [],
  "query": "delete file",
  "totalTools": 2
}
```

The denied or disallowed tools are not in the searchable set. No candidates means no available tool had a positive score for this query. A zero score is excluded even when `minScore` is `0`.

## Response Structure

### Search Response

```json
{
  "topTool": "string | null",           // Best matching tool
  "candidates": [
    {
      "name": "callable tool name returned by search",
      "originalName": "upstream tool name",
      "serverName": "upstream server name",
      "score": 3.5                      // Relevance score (rounded to 2 decimals)
    }
  ],
  "query": "original task description", // Echo of input
  "totalTools": 25                      // Total tools available
}
```

### Call Response

Standard MCP `CallToolResult`:

```json
{
  "content": [
    { "type": "text", "text": "result" }
  ],
  "isError": false  // Optional
}
```

## Error Handling

### Tool Not Found

```json
{
  "content": [{
    "type": "text",
    "text": "Tool not found: nonexistent. Available tools: translate, get_current, ... Use routermcp.searchMcpForTask to discover tools."
  }],
  "isError": true
}
```

### Empty Task

```json
{
  "content": [{
    "type": "text",
    "text": "Error: task parameter is required and cannot be empty"
  }],
  "isError": true
}
```

### No Results

```json
{
  "topTool": null,
  "candidates": [],
  "query": "irrelevant xyz abc",
  "totalTools": 25
}
```

## Best Practices

1. **Use descriptive task descriptions** - Better descriptions yield better matches
2. **Set appropriate minScore** - Filter out low-confidence matches
3. **Limit maxResults** - Reduce noise for the AI model
4. **Combine with filtering** - Restrict available tools for security
5. **Check topTool** - Verify a match was found before calling

## Comparison with Code Mode

| Feature | Tool Search Mode | Code Mode |
|---------|-----------------|-----------|
| **Discovery** | Fuzzy keyword ranking | TypeScript definitions |
| **Execution** | Single tool per call | Multiple tools via JavaScript |
| **Complexity** | Simple 2-step workflow | Full programming environment |
| **Use Case** | Tool discovery & single execution | Multi-tool orchestration |
| **Sandbox** | No code execution | QuickJS WebAssembly |

Choose **Tool Search Mode** when:
- You want typo-tolerant keyword search across tool names and descriptions
- Each task involves one tool call
- You don't need complex orchestration

Choose **Code Mode** when:
- You need multi-tool workflows
- You require conditional logic
- You want data transformation between calls

---

**Up**: [Advanced](../advanced/) | **See Also**: [Code Mode](code-mode.md), [Filtering](../configuration/filtering.md)
