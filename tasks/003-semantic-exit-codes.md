# Task 003: Semantic Exit Codes and Enhanced Error Handling

## Summary

Implement semantic exit codes and enhanced error handling with actionable suggestions, enabling reliable scripting and better debugging.

## Background

The `mcp-cli` project uses semantic exit codes that distinguish between different error types:
- `0` - Success
- `1` - Client error (bad arguments, config issues)
- `2` - Server error (tool execution failed)
- `3` - Network error (connection issues)

This allows scripts and AI agents to programmatically handle different failure modes.

Currently, `routermcp` uses `process.exit(1)` for all errors, making it impossible to distinguish error types in automation.

## Proposed Implementation

### 1. Error Code Enum

Create `src/utils/exit-codes.ts`:

```typescript
export enum ExitCode {
  SUCCESS = 0,
  CLIENT_ERROR = 1,   // Invalid arguments, config errors, user mistakes
  SERVER_ERROR = 2,   // Tool execution failed, upstream errors
  NETWORK_ERROR = 3,  // Connection refused, timeout, HTTP 5xx
}

export function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("rate limit")
  );
}
```

### 2. Error Classification

Create `src/utils/error-classifier.ts`:

```typescript
import { ExitCode } from "./exit-codes.js";

interface ClassifiedError {
  code: ExitCode;
  type: string;
  message: string;
  details?: string;
  suggestion?: string;
}

export function classifyError(error: Error, context?: string): ClassifiedError {
  const message = error.message.toLowerCase();

  // Network errors
  if (isTransientError(error)) {
    return {
      code: ExitCode.NETWORK_ERROR,
      type: "NETWORK_ERROR",
      message: error.message,
      suggestion: "Check network connectivity and retry. The server may be temporarily unavailable.",
    };
  }

  // Config errors
  if (message.includes("config") || message.includes("invalid json")) {
    return {
      code: ExitCode.CLIENT_ERROR,
      type: "CONFIG_ERROR",
      message: error.message,
      suggestion: "Check your routermcp.jsonc configuration file for syntax errors.",
    };
  }

  // Tool not found
  if (message.includes("tool not found")) {
    return {
      code: ExitCode.SERVER_ERROR,
      type: "TOOL_NOT_FOUND",
      message: error.message,
      suggestion: "Run 'routermcp list' to see available tools.",
    };
  }

  // Server not found
  if (message.includes("server not found") || message.includes("unknown server")) {
    return {
      code: ExitCode.CLIENT_ERROR,
      type: "SERVER_NOT_FOUND",
      message: error.message,
      suggestion: "Check server name in config. Run 'routermcp list' to see configured servers.",
    };
  }

  // Tool execution failed
  if (message.includes("tool call failed") || message.includes("execution failed")) {
    return {
      code: ExitCode.SERVER_ERROR,
      type: "TOOL_EXECUTION_FAILED",
      message: error.message,
      suggestion: "Check tool arguments. Run 'routermcp info <tool>' to see the expected schema.",
    };
  }

  // Default to client error
  return {
    code: ExitCode.CLIENT_ERROR,
    type: "UNKNOWN_ERROR",
    message: error.message,
  };
}
```

### 3. Error Formatter

Create `src/utils/error-formatter.ts`:

```typescript
import type { ClassifiedError } from "./error-classifier.js";

export function formatError(error: ClassifiedError, json: boolean): string {
  if (json) {
    return JSON.stringify({
      error: {
        type: error.type,
        message: error.message,
        details: error.details,
        suggestion: error.suggestion,
        exitCode: error.code,
      },
    }, null, 2);
  }

  const lines: string[] = [
    `Error [${error.type}]: ${error.message}`,
  ];

  if (error.details) {
    lines.push(`  Details: ${error.details}`);
  }

  if (error.suggestion) {
    lines.push(`  Suggestion: ${error.suggestion}`);
  }

  return lines.join("\n");
}
```

### 4. Update CLI Entry Point

Modify `src/cli/index.ts`:

```typescript
import { ExitCode } from "../utils/exit-codes.js";
import { classifyError } from "../utils/error-classifier.js";
import { formatError } from "../utils/error-formatter.js";

export async function main(args: string[]): Promise<void> {
  try {
    const { command, options } = parseArgs(args);
    // ... command dispatch
  } catch (error) {
    const classified = classifyError(error as Error);
    console.error(formatError(classified, options?.json ?? false));
    process.exit(classified.code);
  }
}

// Signal handlers
process.on("SIGINT", () => process.exit(130));  // 128 + 2
process.on("SIGTERM", () => process.exit(143)); // 128 + 15
```

### 5. Error Suggestions by Context

| Error Type | Exit Code | Suggestion |
|------------|-----------|------------|
| CONFIG_NOT_FOUND | 1 | Create routermcp.jsonc or specify --config path |
| INVALID_JSON | 1 | Check JSON syntax in config file |
| SERVER_NOT_FOUND | 1 | Check server name, run 'routermcp list' |
| TOOL_NOT_FOUND | 2 | Run 'routermcp list' to see available tools |
| TOOL_EXECUTION_FAILED | 2 | Check arguments, run 'routermcp info <tool>' |
| CONNECTION_REFUSED | 3 | Server may be down, check URL/command |
| TIMEOUT | 3 | Increase timeout or check network |
| UNKNOWN_OPTION | 1 | Run 'routermcp --help' for usage |

## Usage in Scripts

```bash
routermcp call github/search '{"query": "mcp"}'
case $? in
  0) echo "Success" ;;
  1) echo "Client error - check arguments" ;;
  2) echo "Server error - tool failed" ;;
  3) echo "Network error - retry later" ;;
esac
```

## Benefits

1. **Scriptability** - Distinguish error types in automation
2. **Debuggability** - Actionable suggestions guide resolution
3. **AI agent support** - Clear error classification for retries
4. **User experience** - Helpful messages instead of stack traces

## Estimated Effort

- **Size**: Small (1-2 days)
- **Priority**: High
- **Dependencies**: None

## References

- mcp-cli error handling: https://github.com/philschmid/mcp-cli/blob/main/src/errors.ts
