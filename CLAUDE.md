# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

RouterMCP CLI is a Bun-based MCP (Model Context Protocol) Gateway that aggregates multiple upstream MCP servers into a single unified interface. It provides comprehensive tool/resource/prompt filtering, session multiplexing, daemon mode for process sharing, Code Mode for secure JavaScript execution, and Tool Search Mode for intelligent tool discovery with semantic search.

This package is part of the RouterMCP monorepo but can be developed independently. It's published to npm as `routermcp`.

## Common Commands

```bash
# Install dependencies
bun install

# Development (watch mode)
bun run dev

# Type checking
bun run typecheck

# Build for production (ESM, minified, bundled)
bun run build

# Run tests
bun run test              # All tests
bun run test:unit         # Unit tests only
bun run test:integration  # Integration tests only
bun run test:e2e          # E2E tests only
bun run test:coverage     # With coverage report

# Run single test file
bun run test test/unit/filtering/filter.spec.ts

# Run CLI directly
bun run src/index.ts --help
bun run src/index.ts serve -v
bun run src/index.ts proxy --stdio "npx mcp-server"
```

## Linting (from monorepo root)

The CLI package uses Biome for linting/formatting. Run from monorepo root:
```bash
bun run lint              # Check
bun run lint:fix          # Auto-fix
bun run format            # Format
```

Biome config: lineWidth=100, 2-space indents, organized imports.

## Architecture

### Source Structure

```
src/
├── index.ts              # Entry point (env setup, dynamic imports for @clack workaround)
├── cli/                  # CLI commands and argument parsing
│   ├── index.ts          # parseArgs(), main(), command routing
│   ├── serve.ts          # Gateway mode (stdio or HTTP)
│   ├── connect.ts        # Daemon mode client
│   ├── proxy.ts          # Stdio-to-HTTP proxy
│   ├── tunnel.ts         # Public tunnel exposure
│   ├── config.ts         # Interactive configuration wizard
│   ├── doctor.ts         # Config check and OAuth setup
│   ├── oauth.ts          # OAuth token management
│   └── telemetry.ts      # Telemetry enable/disable/status
├── core/                 # Gateway orchestration
│   ├── gateway.ts        # Main Gateway class (connects upstreams, serves MCP)
│   ├── aggregator.ts     # Merges capabilities, applies filters, routes calls
│   ├── upstream.ts       # UpstreamManager for parallel upstream connections
│   ├── virtual-session.ts # Per-session isolation for HTTP multiplexing
│   └── codemode/         # Code Mode: QuickJS sandbox, TypeScript codegen
├── config/               # Configuration loading
│   ├── loader.ts         # JSONC parsing, env var expansion, validation
│   ├── schema.ts         # Zod schemas
│   └── types.ts          # TypeScript types
├── filtering/            # Tool/resource/prompt filtering
│   ├── filter.ts         # shouldAllow() core function
│   └── collision.ts      # Name collision detection
├── transports/           # Protocol implementations
│   ├── stdio.ts          # Stdio transport
│   └── http-streamable.ts # HTTP Streamable transport
├── daemon/               # Background process management
│   ├── lifecycle.ts      # Start/stop daemon
│   ├── paths.ts          # Daemon file paths (~/.routermcp/projects/)
│   └── connection-tracker.ts
├── proxy/                # Stdio-to-HTTP proxy modes
├── tunnel/               # Tunnel providers (Cloudflare, ngrok)
├── oauth/                # OAuth flow handling
├── openapi/              # OpenAPI-to-MCP tool conversion
├── telemetry/            # Anonymous error reporting
└── utils/                # Error classes, credentials
```

### Request Flow

1. **Gateway.start()** → UpstreamManager discovers all upstream servers (parallel)
2. **Capabilities cached** → Tools/resources/prompts extracted with filters applied
3. **Upstreams disconnected** → Discovery complete, connections closed
4. **VirtualSessionManager** → Initialized with cached capabilities
5. **Server transport started** → Ready to accept MCP requests

Per-request (HTTP mode):
```
Request with Mcp-Session-Id header
    → VirtualSessionManager.getOrCreate(sessionId)
    → Aggregator routes call to correct upstream
    → Upstream connects on-demand (lazy connection)
```

### Key Classes

| Class | File | Purpose |
|-------|------|---------|
| `Gateway` | `core/gateway.ts` | Central orchestrator, MCP server |
| `Aggregator` | `core/aggregator.ts` | Merges capabilities, routes calls |
| `UpstreamManager` | `core/upstream.ts` | Manages upstream connections |
| `VirtualSessionManager` | `core/virtual-session.ts` | HTTP session isolation |

### Filter Precedence

```
deny exact → deny glob → allow exact → allow glob → default permit
```

All filtering logic is in `src/filtering/filter.ts:shouldAllow()`.

## Test Structure

```
test/
├── unit/                 # Unit tests (fast, no external deps)
│   ├── filtering/        # Filter logic tests
│   ├── config/           # Config parsing tests
│   └── core/             # Core module tests
├── integration/          # Integration tests (spawn processes)
└── e2e/                  # End-to-end tests
```

Vitest config: `vitest.config.ts` with 75% coverage thresholds.

## Development Notes

- **Bun runtime**: Use Bun APIs. Node.js compat layer in `src/compat/`
- **stdout reserved**: All logging goes to stderr (stdout is for MCP protocol)
- **Transport auto-detect**: `command` key → stdio, `url` key → http-streamable
- **JSONC config**: Supports comments and trailing commas
- **Env substitution**: `${env:VAR}` syntax with `:-default` support
- **Collision failure**: Gateway fails on name collisions - use filtering to resolve
- **Entry point quirk**: Sets `TERM=linux` before @clack/prompts loads (Bun Unicode workaround)

## Defaults

- HTTP port: 5151
- Session timeout: 300 seconds (5 minutes)
- Max sessions: 25
- Daemon idle shutdown: 10 seconds after last client disconnects
- Daemon files: `~/.routermcp/projects/<project-id>/`

## Adding New Features

### New CLI Command
1. Create `src/cli/newcommand.ts` with handler function
2. Add to `parseArgs()` switch in `src/cli/index.ts`
3. Add to `main()` command routing
4. Update `printHelp()` text

### New Filter Type
1. Add fields to `FilterFieldsSchema` in `src/config/schema.ts`
2. Update `FilterFields` type in `src/config/types.ts`
3. Implement in `src/filtering/filter.ts`
4. Update `Aggregator` to use new filter

### New Tunnel Provider
1. Create `src/tunnel/provider-name.ts`
2. Implement `TunnelProviderHandler` interface
3. Register in `src/tunnel/index.ts`
4. Add to CLI help text
