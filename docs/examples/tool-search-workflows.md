---
title: Tool Search Workflows
description: Examples of using Tool Search Mode for intelligent tool discovery
---

# Tool Search Workflows

This example shows how to use Tool Search Mode to discover and execute MCP tools using semantic search.

## Goal

Enable AI models to:
- Discover relevant tools using natural language
- Find tools even with typos or variations
- Execute discovered tools with proper arguments
- Handle cases when no tools match

## Configuration

Create `routermcp.jsonc`:

```jsonc
{
  "strictEnvVars": true,

  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    },
    "weather": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-weather"]
    },
    "translator": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-translator"]
    }
  },

  "mcpToolSearch": {
    "enabled": true,
    "maxResults": 5,
    "minScore": 0.5
  }
}
```

## Workflow 1: Simple Tool Discovery

**User Request:** "Translate hello to Spanish"

**Step 1: Search**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "translate text to spanish"
  }
}
```

**Response:**

```json
{
  "topTool": "translator.translate",
  "candidates": [
    { "name": "translator.translate", "score": 3.5 },
    { "name": "translator.detect_language", "score": 1.0 }
  ],
  "query": "translate text to spanish",
  "totalTools": 42
}
```

**Step 2: Execute**

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "translator.translate",
    "arguments": {
      "text": "hello",
      "target_language": "es"
    }
  }
}
```

**Response:**

```json
{
  "content": [
    { "type": "text", "text": "hola" }
  ]
}
```

## Workflow 2: Handling Typos

**User Request:** "Show me the wether in Paris" (typo: "wether")

**Step 1: Search with Typo**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "get wether for location"
  }
}
```

**Response** (fuzzy matching handles typo):

```json
{
  "topTool": "weather.get_current",
  "candidates": [
    { "name": "weather.get_current", "score": 2.5 },    // Fuzzy match!
    { "name": "weather.get_forecast", "score": 2.0 }
  ],
  "query": "get wether for location",
  "totalTools": 42
}
```

**Step 2: Execute**

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "weather.get_current",
    "arguments": {
      "location": "Paris"
    }
  }
}
```

## Workflow 3: Exploring Related Tools

**User Request:** "What git operations can I do?"

**Search:**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "git operations"
  }
}
```

**Response:**

```json
{
  "topTool": "github.list_repositories",
  "candidates": [
    { "name": "github.list_repositories", "score": 2.0 },
    { "name": "github.create_repository", "score": 2.0 },
    { "name": "github.list_issues", "score": 1.5 },
    { "name": "github.create_issue", "score": 1.0 },
    { "name": "github.search_repositories", "score": 1.0 }
  ],
  "query": "git operations",
  "totalTools": 42
}
```

Now the user can choose which tool to execute.

## Workflow 4: Specific Tool Selection

**User Request:** "Create a new GitHub issue"

**Step 1: Search**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "create github issue"
  }
}
```

**Response:**

```json
{
  "topTool": "github.create_issue",
  "candidates": [
    { "name": "github.create_issue", "score": 4.0 },     // Strong match
    { "name": "github.list_issues", "score": 2.0 },
    { "name": "github.update_issue", "score": 1.5 }
  ],
  "query": "create github issue",
  "totalTools": 42
}
```

**Step 2: Execute**

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "github.create_issue",
    "arguments": {
      "repo": "owner/repo",
      "title": "Bug: Login fails",
      "body": "Users cannot log in with valid credentials",
      "labels": ["bug", "priority-high"]
    }
  }
}
```

## Workflow 5: No Match Found

**User Request:** "Calculate cryptocurrency prices" (no matching tools)

**Search:**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "calculate cryptocurrency prices"
  }
}
```

**Response:**

```json
{
  "topTool": null,
  "candidates": [],
  "query": "calculate cryptocurrency prices",
  "totalTools": 42
}
```

**AI can respond:** "I don't have any tools for cryptocurrency price calculations. Available tool categories include: filesystem, github, weather, translator."

## Workflow 6: File Operations

**User Request:** "Read the contents of README.md"

**Step 1: Search**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "read file contents"
  }
}
```

**Response:**

```json
{
  "topTool": "filesystem.read_file",
  "candidates": [
    { "name": "filesystem.read_file", "score": 3.5 },
    { "name": "filesystem.list_directory", "score": 1.0 },
    { "name": "filesystem.get_file_info", "score": 1.0 }
  ],
  "query": "read file contents",
  "totalTools": 42
}
```

**Step 2: Execute**

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "filesystem.read_file",
    "arguments": {
      "path": "./README.md"
    }
  }
}
```

## Workflow 7: CamelCase Tool Names

**User Request:** "Get user information"

**Search:**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "get user info"
  }
}
```

**Response** (tokenization handles camelCase):

```json
{
  "topTool": "api.getUserInfo",
  "candidates": [
    { "name": "api.getUserInfo", "score": 4.0 },        // Matches!
    { "name": "api.updateUserProfile", "score": 2.0 },
    { "name": "database.queryUsers", "score": 1.5 }
  ],
  "query": "get user info",
  "totalTools": 42
}
```

## Workflow 8: With Filtering

**Configuration with restrictions:**

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
    "enabled": true,
    "minScore": 1.0
  }
}
```

**User Request:** "Delete README.md"

**Search:**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "delete file"
  }
}
```

**Response:**

```json
{
  "topTool": null,
  "candidates": [],
  "query": "delete file",
  "totalTools": 8  // Only filtered tools counted
}
```

**AI can respond:** "I don't have permission to delete files. I can only read and list files."

## Workflow 9: High Precision Search

**Configuration:**

```jsonc
{
  "mcpToolSearch": {
    "enabled": true,
    "maxResults": 3,
    "minScore": 2.5  // Only strong matches
  }
}
```

**Search:**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "weather"
  }
}
```

**Response:**

```json
{
  "topTool": "weather.get_current",
  "candidates": [
    { "name": "weather.get_current", "score": 3.0 },
    { "name": "weather.get_forecast", "score": 2.8 }
    // "weather.get_alerts" with score 1.5 is filtered out
  ],
  "query": "weather",
  "totalTools": 42
}
```

## Workflow 10: Multi-Step Discovery

**User Request:** "I want to work with GitHub"

**Step 1: Broad Search**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "github operations"
  }
}
```

**Response:**

```json
{
  "candidates": [
    { "name": "github.list_repositories", "score": 2.5 },
    { "name": "github.create_repository", "score": 2.5 },
    { "name": "github.list_issues", "score": 2.0 },
    { "name": "github.create_issue", "score": 2.0 },
    { "name": "github.update_issue", "score": 1.5 }
  ]
}
```

**AI presents options to user, user chooses "list my repositories"**

**Step 2: Specific Search**

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": "list github repositories"
  }
}
```

**Response:**

```json
{
  "topTool": "github.list_repositories",
  "candidates": [
    { "name": "github.list_repositories", "score": 4.5 }
  ]
}
```

**Step 3: Execute**

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "github.list_repositories",
    "arguments": {}
  }
}
```

## Error Handling Examples

### Invalid Tool Name

```json
{
  "name": "routermcp.callTool",
  "arguments": {
    "name": "nonexistent.tool",
    "arguments": {}
  }
}
```

**Response:**

```json
{
  "content": [{
    "type": "text",
    "text": "Tool not found: nonexistent.tool. Available tools: filesystem.read_file, github.list_issues, ... Use routermcp.searchMcpForTask to discover tools."
  }],
  "isError": true
}
```

### Empty Task

```json
{
  "name": "routermcp.searchMcpForTask",
  "arguments": {
    "task": ""
  }
}
```

**Response:**

```json
{
  "content": [{
    "type": "text",
    "text": "Error: task parameter is required and cannot be empty"
  }],
  "isError": true
}
```

## Best Practices

1. **Use descriptive task descriptions**
   - ✅ "translate text to french"
   - ❌ "translate"

2. **Check topTool before calling**
   ```
   if (searchResult.topTool) {
     // Tool found, proceed to call
   } else {
     // No matching tool, inform user
   }
   ```

3. **Leverage candidate scores**
   - Scores > 2.0: Strong matches
   - Scores 1.0-2.0: Moderate matches
   - Scores < 1.0: Weak matches

4. **Handle typos gracefully**
   - Fuzzy matching handles minor typos automatically
   - Large typos may still fail to match

5. **Present options when appropriate**
   - If multiple high-scoring candidates, let user choose
   - Don't auto-select if score difference is small

---

**Previous**: [Code Mode Workflows](code-mode-workflows.md) | **Up**: [Examples](../examples/)
