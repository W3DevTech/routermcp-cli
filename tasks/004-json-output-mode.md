# Task 004: JSON Output Mode for Shell Composability

## Summary

Add `--json` / `-j` flag to all commands for machine-readable output, enabling shell composability with tools like `jq`, `xargs`, and AI agents.

## Background

The `mcp-cli` project supports dual output modes:
- **Text mode (default)** - Human-readable, colorized output
- **JSON mode (`--json`)** - Structured data for scripting

This enables powerful shell pipelines:
```bash
routermcp list --json | jq '.[] | select(.tools | length > 5)'
```

Currently, `routermcp` outputs to stderr for logging but lacks structured output mode.

## Proposed Implementation

### 1. Output Module

Create `src/output/index.ts`:

```typescript
export interface OutputOptions {
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
}

export function shouldColorize(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY ?? false;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function color(text: string, code: string): string {
  if (!shouldColorize()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const colors = {
  cyan: (text: string) => color(text, "36"),
  dim: (text: string) => color(text, "2"),
  green: (text: string) => color(text, "32"),
  red: (text: string) => color(text, "31"),
  yellow: (text: string) => color(text, "33"),
  bold: (text: string) => color(text, "1"),
};
```

### 2. Formatted Output Functions

Create `src/output/formatters.ts`:

```typescript
import { colors, formatJson, type OutputOptions } from "./index.js";

interface ServerWithTools {
  name: string;
  tools: Array<{ name: string; description?: string }>;
  error?: string;
}

export function formatServerList(
  servers: ServerWithTools[],
  options: OutputOptions
): string {
  if (options.json) {
    return formatJson(servers);
  }

  const lines: string[] = [];
  for (const server of servers) {
    lines.push(colors.bold(colors.cyan(server.name)));

    if (server.error) {
      lines.push(`  ${colors.red("•")} <error: ${server.error}>`);
    } else {
      for (const tool of server.tools) {
        const desc = tool.description ? colors.dim(` - ${tool.description}`) : "";
        lines.push(`  • ${tool.name}${desc}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatToolSchema(
  tool: { name: string; description?: string; inputSchema: unknown },
  serverName: string,
  options: OutputOptions
): string {
  if (options.json) {
    return formatJson({ server: serverName, tool });
  }

  return `
${colors.bold("Tool:")} ${tool.name}
${colors.bold("Server:")} ${serverName}

${colors.bold("Description:")}
  ${tool.description || "No description"}

${colors.bold("Input Schema:")}
${JSON.stringify(tool.inputSchema, null, 2).split("\n").map(l => "  " + l).join("\n")}
`.trim();
}

export function formatCallResult(
  result: { content: unknown[]; isError?: boolean },
  options: OutputOptions
): string {
  if (options.json) {
    return formatJson(result);
  }

  // Extract text content for human-readable output
  const textContent = result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

  if (result.isError) {
    return colors.red(`Error: ${textContent}`);
  }

  return textContent;
}
```

### 3. Update CLI Commands

Modify `src/cli/index.ts` to accept `--json` flag:

```typescript
case "--json":
case "-j":
  options.json = true;
  break;
```

Update all commands to use formatters:

```typescript
// Example: list command
export async function listCommand(options: ListOptions): Promise<void> {
  const servers = await discoverServers(options.config);
  const output = formatServerList(servers, { json: options.json });
  console.log(output);
}
```

### 4. Stdout/Stderr Separation

Follow the convention:
- **stdout** - Tool results, data output (for piping)
- **stderr** - Logs, errors, diagnostics

```typescript
// Data goes to stdout
console.log(formatJson(result));

// Logs go to stderr
console.error("[routermcp] Connecting to servers...");
```

### 5. Shell Integration Examples

#### List and filter
```bash
# Find servers with more than 5 tools
routermcp list --json | jq '.[] | select(.tools | length > 5) | .name'

# Count total tools
routermcp list --json | jq '[.[].tools[]] | length'

# Get all tool names as flat list
routermcp list --json | jq -r '.[].tools[].name'
```

#### Search and inspect
```bash
# Find tools and get their schemas
routermcp search "*file*" --json | jq -r '.[].name' | while read tool; do
  routermcp info "$tool" --json
done
```

#### Execute and process
```bash
# Call tool and extract specific field
routermcp call github/search '{"query": "mcp"}' --json | jq '.content[0].text'

# Pipe results to another tool
routermcp call filesystem/read_file '{"path": "data.json"}' --json \
  | jq -r '.content[0].text' \
  | routermcp call process/analyze -
```

## Output Format Reference

| Command | JSON Structure |
|---------|---------------|
| `list` | `[{ name, tools: [{ name, description }], error? }]` |
| `search` | `[{ name, server, description }]` |
| `info <server>` | `{ name, transport, command/url, tools }` |
| `info <tool>` | `{ server, tool: { name, description, inputSchema } }` |
| `call` | `{ content: [{ type, text }], isError? }` |
| Error | `{ error: { type, message, suggestion, exitCode } }` |

## Benefits

1. **Shell composability** - Pipe output through jq, awk, grep
2. **CI/CD integration** - Parse results in GitHub Actions, etc.
3. **AI agent support** - Structured data for programmatic use
4. **Scripting** - Build complex workflows with shell scripts

## Estimated Effort

- **Size**: Small (1-2 days)
- **Priority**: High
- **Dependencies**: Task 001 (Interactive Tool Discovery)

## References

- mcp-cli output module: https://github.com/philschmid/mcp-cli/blob/main/src/output.ts
