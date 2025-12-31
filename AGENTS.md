# PROJECT KNOWLEDGE BASE

**Generated:** 2025-12-30
**Branch:** main

## OVERVIEW

MCP Gateway CLI that aggregates multiple upstream MCP servers into single unified interface. Routes tool/resource/prompt calls to appropriate upstream with comprehensive filtering. Supports HTTP session multiplexing, daemon mode for process sharing, and Code Mode for secure JavaScript execution with MCP tool access. Built with Bun runtime, TypeScript strict mode.

## STRUCTURE

```
packages/cli/
├── src/
│   ├── cli/           # CLI commands (serve, connect, config, tunnel, proxy, telemetry)
│   ├── core/          # Gateway orchestration, upstream management, aggregation, sessions
│   │   └── codemode/  # Code Mode: sandbox, codegen, meta-tools
│   ├── daemon/        # Daemon lifecycle, project isolation, connection tracking
│   ├── transports/    # stdio + HTTP streamable protocol implementations
│   ├── tunnel/        # Cloudflare, ngrok, routermcp-cloud providers
│   ├── filtering/     # Allow/deny filtering with glob patterns
│   ├── config/        # JSONC loading, Zod validation, env var expansion
│   ├── compat/        # Bun/Node compatibility layer
│   ├── proxy/         # Stdio-to-HTTP proxy (SSE, Streamable HTTP)
│   ├── telemetry/     # Error reporting to Axiom (enabled by default)
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
| Session management | `src/core/virtual-session.ts` | VirtualSessionManager for HTTP multiplexing |
| Daemon lifecycle | `src/daemon/lifecycle.ts` | Start/stop/health check daemon processes |
| Daemon paths | `src/daemon/paths.ts` | File paths for daemon state (pid, port, socket) |
| Code Mode sandbox | `src/core/codemode/sandbox.ts` | QuickJS WASM execution environment |
| Code Mode codegen | `src/core/codemode/codegen.ts` | TypeScript definition generator |
| Code Mode meta-tools | `src/core/codemode/meta-tools.ts` | listTools and executeCode handlers |
| Telemetry config | `src/telemetry/config.ts` | Load/save telemetry prefs from ~/.routermcp/config.json |
| Telemetry reporting | `src/telemetry/reporter.ts` | Build and send error events to Axiom |
| Telemetry CLI | `src/cli/telemetry.ts` | enable/disable/status commands |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `Gateway` | Class | `core/gateway.ts` | Central orchestrator - connects upstreams, serves MCP |
| `Aggregator` | Class | `core/aggregator.ts` | Merges capabilities, applies filters, routes calls |
| `UpstreamManager` | Class | `core/upstream.ts` | Manages parallel upstream connections |
| `VirtualSessionManager` | Class | `core/virtual-session.ts` | Per-session isolation for HTTP multiplexing |
| `shouldAllow` | Function | `filtering/filter.ts` | Core filter logic (deny > allow > default) |
| `loadConfig` | Function | `config/loader.ts` | JSONC parse + normalize + expand env + validate |
| `createClientTransport` | Function | `transports/index.ts` | Factory for upstream connections |
| `createServerTransport` | Function | `transports/index.ts` | Factory for gateway output |
| `startDaemon` | Function | `daemon/lifecycle.ts` | Spawn background daemon process |
| `getDaemonStatus` | Function | `daemon/lifecycle.ts` | Check if daemon is running |
| `connectCommand` | Function | `cli/connect.ts` | Stdio-to-daemon proxy |
| `executeCodeMode` | Function | `core/codemode/sandbox.ts` | Execute JS in QuickJS WASM sandbox |
| `generateTypeScriptDefinitions` | Function | `core/codemode/codegen.ts` | Convert tool schemas to TS declarations |
| `handleListTools` | Function | `core/codemode/meta-tools.ts` | Handler for routermcp.listTools |
| `handleExecuteCode` | Function | `core/codemode/meta-tools.ts` | Handler for routermcp.executeCode |
| `reportError` | Function | `telemetry/reporter.ts` | Send CLI errors to Axiom telemetry |
| `isTelemetryEnabled` | Function | `telemetry/config.ts` | Check if telemetry is enabled |
| `setTelemetryEnabled` | Function | `telemetry/config.ts` | Enable/disable telemetry |

### Module Flow

```
CLI (serve/tunnel/config)
    │
    ▼
Gateway.start()
    │
    ├──► UpstreamManager.discoverAll()
    │         │
    │         └──► createClientTransport() per server (discovery only)
    │
    ├──► Extract & cache capabilities
    │         │
    │         └──► Disconnect all (discovery complete)
    │
    ├──► VirtualSessionManager.init()
    │         │
    │         └──► setCapabilityCache() (shared read-only)
    │
    └──► createServerTransport() ──► MCP Server ready

Per-Request Flow (HTTP mode):
    │
    Request with Mcp-Session-Id header
    │
    ▼
VirtualSessionManager.getOrCreate(sessionId)
    │
    ├──► Create lazy UpstreamManager (per session)
    │
    └──► Aggregator routes call to upstream
              │
              └──► Upstream connects on-demand
```

### Daemon Mode Flow

```
routermcp connect
    │
    ▼
getDaemonStatus(paths)
    │
    ├── Running? ──► proxyStdioToHttp()
    │
    └── Stopped? ──► startDaemon(paths)
                          │
                          └──► spawn("routermcp serve --daemon-mode")
                                    │
                                    └──► Write pid/port files
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
- **Env substitution**: `${env:VAR_NAME}` syntax with `:-default` support. Legacy `${VAR_NAME}` still works but deprecated.
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
| `@sebastianwessel/quickjs` | QuickJS WASM sandbox for Code Mode |
| `@jitl/quickjs-ng-wasmfile-release-sync` | QuickJS WASM variant |

## NOTES

- Entry `src/index.ts` sets `TERM=linux` before loading @clack/prompts (Bun Unicode workaround)
- Config files: `routermcp.jsonc` or `routermcp.json` (auto-detected)
- HTTP default port: 5151
- Session timeout: 300s (5 minutes), max 25 sessions by default
- Daemon idle shutdown: 10 seconds after last client disconnects
- Daemon files stored in `~/.routermcp/projects/<project-id>/`
- No tests currently - consider adding before major changes
- Monorepo member: Root has Biome config, other packages may exist
