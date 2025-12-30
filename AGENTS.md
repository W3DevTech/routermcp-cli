# PROJECT KNOWLEDGE BASE

**Generated:** 2025-12-30
**Commit:** bcaeb24
**Branch:** main

## OVERVIEW

MCP Gateway CLI that aggregates multiple upstream MCP servers into single unified interface. Routes tool/resource/prompt calls to appropriate upstream with comprehensive filtering. Built with Bun runtime, TypeScript strict mode.

## STRUCTURE

```
packages/cli/
├── src/
│   ├── cli/           # CLI commands (serve, config, tunnel)
│   ├── core/          # Gateway orchestration, upstream management, aggregation
│   ├── transports/    # stdio + HTTP streamable protocol implementations
│   ├── tunnel/        # Cloudflare, ngrok, routermcp-cloud providers
│   ├── filtering/     # Allow/deny filtering with glob patterns
│   ├── config/        # JSONC loading, Zod validation, env var expansion
│   ├── compat/        # Bun/Node compatibility layer
│   └── utils/         # Custom error classes
├── scripts/           # npm readme preparation
└── dist/              # Built output (ESM, minified)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add CLI command | `src/cli/index.ts` | Add to parseArgs switch, create handler in new file |
| Add tunnel provider | `src/tunnel/` | Implement TunnelProviderHandler, register in index.ts |
| Modify filtering logic | `src/filtering/filter.ts` | shouldAllow() is core filter function |
| Add config option | `src/config/types.ts` + `schema.ts` | Update interface AND Zod schema |
| Transport changes | `src/transports/` | stdio.ts or http-streamable.ts |
| Upstream connection | `src/core/upstream.ts` | UpstreamManager handles all connections |
| Request routing | `src/core/aggregator.ts` | Routes calls to correct upstream |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `Gateway` | Class | `core/gateway.ts` | Central orchestrator - connects upstreams, serves MCP |
| `Aggregator` | Class | `core/aggregator.ts` | Merges capabilities, applies filters, routes calls |
| `UpstreamManager` | Class | `core/upstream.ts` | Manages parallel upstream connections |
| `shouldAllow` | Function | `filtering/filter.ts` | Core filter logic (deny > allow > default) |
| `loadConfig` | Function | `config/loader.ts` | JSONC parse + normalize + expand env + validate |
| `createClientTransport` | Function | `transports/index.ts` | Factory for upstream connections |
| `createServerTransport` | Function | `transports/index.ts` | Factory for gateway output |

### Module Flow

```
CLI (serve/tunnel/config)
    │
    ▼
Gateway.start()
    │
    ├──► UpstreamManager.connectAll()
    │         │
    │         └──► createClientTransport() per server
    │
    ├──► Aggregator.refresh()
    │         │
    │         ├──► Apply filtering (shouldAllow)
    │         └──► Check collisions
    │
    └──► createServerTransport() ──► MCP Server ready
```

## CONVENTIONS

- **Bun runtime**: Use `bun run`, not `npm run`. Build uses `bun build` not tsc
- **Biome formatter**: lineWidth=100 (not 80). Run from monorepo root
- **Transport auto-detect**: `command` key = stdio, `url` key = http-streamable
- **Error classes**: Extend RouterMcpError in `utils/errors.ts`
- **Logging**: Use `console.error()` for logs (stdout reserved for MCP protocol)
- **Filter precedence**: deny exact > deny glob > allow exact > allow glob > default permit

## ANTI-PATTERNS (THIS PROJECT)

- **stdout for logs**: MCP protocol uses stdout. All logging must go to stderr
- **Sync imports**: Entry point uses dynamic import for TERM env workaround
- **Node.js APIs**: Use Bun APIs or compat layer in `src/compat/`
- **Collision ignorance**: Gateway fails on name collisions - use filtering to resolve

## UNIQUE STYLES

- **JSONC config**: Supports comments and trailing commas (jsonc-parser)
- **Env substitution**: `${VAR_NAME}` syntax in config values
- **Claude Code compat**: Accepts `type` field as alias for `transport`
- **Graceful degradation**: Failed upstream connections don't block gateway start

## COMMANDS

```bash
bun run dev          # Watch mode development
bun run build        # Production build (ESM, minified, bundled)
bun run typecheck    # TypeScript check (noEmit)
bun run start        # Run built CLI
```

## DEPENDENCIES

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP client/server, types, transports |
| `@clack/prompts` | Interactive CLI prompts |
| `zod` | Config schema validation |
| `micromatch` | Glob pattern matching for filters |
| `jsonc-parser` | JSON with comments parsing |

## NOTES

- Entry `src/index.ts` sets `TERM=linux` before loading @clack/prompts (Bun Unicode workaround)
- Config files: `routermcp.jsonc` or `routermcp.json` (auto-detected)
- HTTP default port: 5151
- No tests currently - consider adding before major changes
- Monorepo member: Root has Biome config, other packages may exist
