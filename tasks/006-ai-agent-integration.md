# Task 006: AI Agent Integration and SKILL.md

## Summary

Create documentation and features specifically designed for AI coding agents (Claude Code, Gemini CLI, Cursor, etc.) to efficiently use routermcp.

## Background

The `mcp-cli` project includes a `SKILL.md` file that AI agents can read to understand how to use the CLI effectively. This file describes:
- Token-efficient workflow (discover → inspect → execute)
- Command syntax and examples
- Exit code semantics for error handling
- Best practices for AI agents

This approach reduces token consumption by ~90% compared to preloading all tool schemas.

## Proposed Implementation

### 1. Create SKILL.md

Create `SKILL.md` in the package root:

```markdown
# RouterMCP CLI - AI Agent Guide

## Overview

RouterMCP is an MCP gateway that aggregates multiple upstream servers.
Use these commands for token-efficient tool interaction.

## Three-Step Workflow

1. **Discover** - Find available tools
2. **Inspect** - Get schema for specific tool
3. **Execute** - Call tool with arguments

This workflow minimizes token usage by loading schemas on-demand.

## Commands

### Discovery
```bash
routermcp list                    # List all tools (~10 tokens)
routermcp list -d                 # With descriptions (~50 tokens)
routermcp search "*file*"         # Search by pattern
```

### Inspection
```bash
routermcp info <server>           # Server details
routermcp info <server>/<tool>    # Tool schema (~100 tokens)
```

### Execution
```bash
routermcp call <server>/<tool> '<json>'    # Execute tool
routermcp call <tool> - <<EOF              # Use stdin for complex JSON
{"key": "value with 'quotes'"}
EOF
```

## Output Modes

- Default: Human-readable text
- `--json`: Machine-parseable JSON (preferred for scripting)

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Process result |
| 1 | Client error | Fix arguments/config |
| 2 | Server error | Check tool schema |
| 3 | Network error | Retry later |

## Best Practices for AI Agents

1. **Start with discovery** - Run `routermcp list` first
2. **Inspect before calling** - Always check schema with `routermcp info`
3. **Use stdin for JSON** - Avoid shell escaping issues
4. **Check exit codes** - Handle errors appropriately
5. **Use --json** - Parse structured output reliably

## Examples

### Find and use a file tool
```bash
# 1. Search for file-related tools
routermcp search "*file*"

# 2. Get schema
routermcp info filesystem/read_file

# 3. Execute
routermcp call filesystem/read_file '{"path": "./README.md"}'
```

### Handle errors
```bash
if ! result=$(routermcp call tool/name '{}' 2>&1); then
  case $? in
    1) echo "Fix your arguments" ;;
    2) echo "Tool failed, check schema" ;;
    3) echo "Network issue, retry" ;;
  esac
fi
```

## Token Efficiency

| Approach | Tokens | When |
|----------|--------|------|
| `routermcp list` | ~10 | Initial discovery |
| `routermcp info <tool>` | ~100 | Before first call |
| `routermcp call <tool>` | ~50 | Each execution |
| Full schema preload | ~1000+ | Never needed |
```

### 2. Add SKILL.md Reference to README

Update `README.md` to mention SKILL.md:

```markdown
## AI Agent Integration

For AI coding agents (Claude Code, Gemini CLI, Cursor, etc.),
see [SKILL.md](./SKILL.md) for token-efficient usage patterns.
```

### 3. Minimal Context Mode

Add `--minimal` flag that outputs only essential information:

```bash
# Standard output
routermcp list
# github
#   • search_repositories - Search for GitHub repositories
#   • get_file_contents - Get contents of a file

# Minimal output (for AI context windows)
routermcp list --minimal
# github: search_repositories, get_file_contents
# filesystem: read_file, write_file, list_directory
```

### 4. Schema Summary Mode

Add concise schema output for AI consumption:

```bash
routermcp info filesystem/read_file --brief
# read_file(path: string) -> text
# Reads file contents. Required: path

routermcp info github/search_repositories --brief
# search_repositories(query: string, page?: number, per_page?: number) -> json
# Searches GitHub repositories. Required: query
```

### 5. Suggested Prompt for AI Agents

When an AI agent needs to interact with MCP tools:

```markdown
## MCP Tool Usage

To interact with MCP tools via routermcp:

1. First, run `routermcp list` to discover available tools
2. For tool details, run `routermcp info <server>/<tool>`
3. Execute with `routermcp call <server>/<tool> '<json-args>'`

Use `--json` flag for machine-readable output.
Check exit codes: 0=success, 1=client error, 2=server error, 3=network error.
```

### 6. Context Window Optimization

Add flags to control output verbosity:

```typescript
interface OutputOptions {
  json?: boolean;
  minimal?: boolean;  // Compact output for AI context
  brief?: boolean;    // One-line summaries
  noColor?: boolean;  // Disable ANSI codes
}
```

## Benefits

1. **Token efficiency** - Reduce AI context consumption by 90%
2. **Standardized workflow** - Consistent discover → inspect → execute pattern
3. **Error handling** - Clear exit codes for programmatic handling
4. **Documentation** - SKILL.md serves as agent instruction file

## Estimated Effort

- **Size**: Small (1 day)
- **Priority**: Medium
- **Dependencies**: Task 001 (Interactive Tool Discovery)

## References

- mcp-cli SKILL.md: https://github.com/philschmid/mcp-cli/blob/main/SKILL.md
- Token-efficient patterns: https://deepwiki.com/philschmid/mcp-cli#ai-agent-integration
