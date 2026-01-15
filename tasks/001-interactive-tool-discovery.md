# Task 001: Add Interactive Tool Discovery Commands

## Summary

Add lightweight CLI commands for tool discovery, inspection, and direct execution - inspired by `mcp-cli` (philschmid/mcp-cli).

## Background

The `mcp-cli` project provides a simple, shell-friendly CLI for interacting with MCP servers. It follows a three-step workflow: **discover → inspect → execute**. This pattern is token-efficient for AI agents and user-friendly for developers.

Currently, `routermcp` focuses on running as a gateway (serve mode) but lacks commands for quick tool discovery and direct execution without starting a full server.

## Proposed Commands

### 1. `routermcp list`
List all aggregated tools/resources/prompts from configured servers.

```bash
routermcp list                    # List all tools
routermcp list -d                 # Include descriptions
routermcp list --json             # JSON output
routermcp list --resources        # List resources instead
routermcp list --prompts          # List prompts instead
```

**Output example:**
```
github
  • search_repositories - Search for GitHub repositories
  • get_file_contents - Get contents of a file
filesystem
  • read_file - Read the contents of a file
  • write_file - Write content to a file
```

### 2. `routermcp search <pattern>`
Search tools across all servers using glob patterns.

```bash
routermcp search "*file*"         # Find file-related tools
routermcp search "github/*"       # Find tools from github server
routermcp search "*read*" -d      # Include descriptions
routermcp search "*" --json       # JSON output
```

### 3. `routermcp info <server>` or `routermcp info <tool>`
Show detailed schema for a specific server or tool.

```bash
routermcp info filesystem                  # Show server details + tools
routermcp info filesystem/read_file        # Show tool schema
routermcp info github/search_repositories  # Show input schema
```

**Output example:**
```
Tool: read_file
Server: filesystem

Description:
  Read the contents of a file

Input Schema:
  {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "File path" }
    },
    "required": ["path"]
  }
```

### 4. `routermcp call <tool> [args]`
Execute a tool directly without starting a gateway.

```bash
routermcp call filesystem/read_file '{"path": "./README.md"}'
echo '{"path": "./README.md"}' | routermcp call filesystem/read_file -
routermcp call github/search_repositories '{"query": "mcp"}' --json
```

## Implementation Details

### New Files
- `src/cli/list.ts` - List command implementation
- `src/cli/search.ts` - Search command implementation
- `src/cli/info.ts` - Info command implementation
- `src/cli/call.ts` - Call command implementation
- `src/output/format.ts` - Output formatting utilities

### Key Features
1. **Parallel server discovery** - Use existing `UpstreamManager` with concurrency control
2. **On-demand connection** - Connect only when needed, disconnect after use
3. **Filtering support** - Apply existing tool/resource/prompt filters
4. **JSON output mode** - Add `--json` flag for machine-readable output
5. **Colorized output** - Pretty terminal output with auto TTY detection

### Changes to Existing Files
- `src/cli/index.ts` - Add new commands to parser and dispatcher
- Reuse `src/core/aggregator.ts` for tool aggregation
- Reuse `src/filtering/filter.ts` for pattern matching

## Benefits

1. **Token efficiency** - AI agents fetch schemas on-demand instead of preloading all
2. **Shell composability** - JSON output enables piping through jq, xargs, etc.
3. **Developer experience** - Quick exploration without starting a gateway
4. **Debugging** - Easily test individual tools before integration

## Estimated Effort

- **Size**: Medium (3-5 days)
- **Priority**: High
- **Dependencies**: None (uses existing infrastructure)

## References

- mcp-cli source: https://github.com/philschmid/mcp-cli
- DeepWiki documentation: https://deepwiki.com/philschmid/mcp-cli
