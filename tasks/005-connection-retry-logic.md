# Task 005: Connection Retry Logic with Exponential Backoff

## Summary

Implement robust retry logic with exponential backoff for transient network errors, configurable via environment variables.

## Background

The `mcp-cli` project implements a `withRetry()` wrapper that:
- Retries transient errors (network issues, HTTP 502/503/504, rate limiting)
- Uses exponential backoff to avoid overwhelming servers
- Is configurable via environment variables

Currently, `routermcp` has basic timeout handling but no retry logic for transient failures.

## Proposed Implementation

### 1. Retry Configuration

Add to `src/config/types.ts`:

```typescript
export interface RetryConfig {
  maxRetries: number;      // Default: 3
  baseDelay: number;       // Default: 1000ms
  maxDelay: number;        // Default: 30000ms
  backoffMultiplier: number; // Default: 2
}

export function getRetryConfig(): RetryConfig {
  return {
    maxRetries: parseInt(process.env.ROUTERMCP_MAX_RETRIES || "3", 10),
    baseDelay: parseInt(process.env.ROUTERMCP_RETRY_DELAY || "1000", 10),
    maxDelay: parseInt(process.env.ROUTERMCP_MAX_RETRY_DELAY || "30000", 10),
    backoffMultiplier: parseFloat(process.env.ROUTERMCP_BACKOFF_MULTIPLIER || "2"),
  };
}
```

### 2. Transient Error Detection

Create `src/utils/retry.ts`:

```typescript
export function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const code = (error as any).code?.toLowerCase() || "";

  // Network errors
  if (code === "econnrefused") return true;
  if (code === "etimedout") return true;
  if (code === "econnreset") return true;
  if (code === "enotfound") return false; // DNS failure is not transient

  // HTTP errors
  if (message.includes("502")) return true; // Bad Gateway
  if (message.includes("503")) return true; // Service Unavailable
  if (message.includes("504")) return true; // Gateway Timeout
  if (message.includes("429")) return true; // Too Many Requests

  // Specific transient messages
  if (message.includes("socket hang up")) return true;
  if (message.includes("connection reset")) return true;
  if (message.includes("rate limit")) return true;
  if (message.includes("temporarily unavailable")) return true;

  return false;
}

export function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  multiplier: number
): number {
  // Exponential backoff with jitter
  const exponentialDelay = baseDelay * Math.pow(multiplier, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}
```

### 3. Retry Wrapper

Add to `src/utils/retry.ts`:

```typescript
import { getRetryConfig, type RetryConfig } from "../config/types.js";

export interface RetryOptions {
  config?: Partial<RetryConfig>;
  onRetry?: (attempt: number, error: Error, delay: number) => void;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config = { ...getRetryConfig(), ...options.config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Don't retry non-transient errors
      if (!isTransientError(lastError)) {
        throw lastError;
      }

      // Don't retry after max attempts
      if (attempt >= config.maxRetries) {
        throw lastError;
      }

      const delay = calculateBackoff(
        attempt,
        config.baseDelay,
        config.maxDelay,
        config.backoffMultiplier
      );

      options.onRetry?.(attempt + 1, lastError, delay);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

### 4. Integration with Upstream Manager

Update `src/core/upstream.ts`:

```typescript
import { withRetry } from "../utils/retry.js";

async ensureConnected(serverName: string): Promise<Client> {
  const server = this.servers.get(serverName);
  if (!server) {
    throw new Error(`Unknown server: ${serverName}`);
  }

  if (server.client) {
    return server.client;
  }

  return withRetry(
    async () => {
      const client = await this.connect(server);
      server.client = client;
      return client;
    },
    {
      onRetry: (attempt, error, delay) => {
        if (this.verbose) {
          console.error(
            `[upstream] Retry ${attempt} for ${serverName} after ${delay}ms: ${error.message}`
          );
        }
      },
    }
  );
}
```

### 5. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTERMCP_MAX_RETRIES` | `3` | Maximum retry attempts (0 to disable) |
| `ROUTERMCP_RETRY_DELAY` | `1000` | Base delay in milliseconds |
| `ROUTERMCP_MAX_RETRY_DELAY` | `30000` | Maximum delay cap |
| `ROUTERMCP_BACKOFF_MULTIPLIER` | `2` | Exponential backoff multiplier |

### 6. Retry Behavior Examples

```
Attempt 1: Immediate
Attempt 2: ~1000ms delay (base)
Attempt 3: ~2000ms delay (base * 2)
Attempt 4: ~4000ms delay (base * 4)
(Maximum delay capped at 30000ms)
```

With jitter (±30%):
```
Attempt 2: 700-1300ms
Attempt 3: 1400-2600ms
Attempt 4: 2800-5200ms
```

### 7. Usage Examples

```bash
# Disable retries for fast failure
ROUTERMCP_MAX_RETRIES=0 routermcp call github/search '{"query": "mcp"}'

# Aggressive retries for unreliable network
ROUTERMCP_MAX_RETRIES=5 ROUTERMCP_RETRY_DELAY=500 routermcp serve

# Longer delays for rate-limited APIs
ROUTERMCP_RETRY_DELAY=5000 ROUTERMCP_BACKOFF_MULTIPLIER=3 routermcp serve
```

## Error Messages

When retries are exhausted:

```
Error [NETWORK_ERROR]: Connection to github failed after 3 retries
  Last error: ECONNREFUSED 127.0.0.1:3000
  Suggestion: Check if the server is running and accessible
```

## Benefits

1. **Resilience** - Automatic recovery from transient failures
2. **Rate limit handling** - Backoff prevents API bans
3. **Better UX** - Transparent retries reduce manual intervention
4. **Configurability** - Fine-tune for specific environments

## Estimated Effort

- **Size**: Small (1 day)
- **Priority**: Medium
- **Dependencies**: None

## References

- mcp-cli retry logic: https://github.com/philschmid/mcp-cli/blob/main/src/client.ts
- Exponential backoff patterns: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
