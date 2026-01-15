# RouterMCP CLI Improvement Tasks

## Overview

This document summarizes improvement opportunities for `routermcp-cli` based on analysis of the `mcp-cli` project (https://github.com/philschmid/mcp-cli).

## Comparison Summary

### mcp-cli (philschmid)
A **lightweight CLI for interacting with MCP servers**, focused on:
- Tool discovery, inspection, and execution
- Token-efficient workflows for AI agents
- Shell composability (JSON output, piping)
- Single binary distribution
- Simple configuration format

### routermcp-cli
A **full MCP gateway that aggregates multiple servers**, featuring:
- Gateway mode (serve, connect, proxy)
- Tool/resource/prompt filtering
- Session management & daemon mode
- Code Mode (QuickJS sandbox)
- OpenAPI-to-MCP conversion
- OAuth authentication
- Tunnel providers (Cloudflare, ngrok)

## Key Insight

The projects serve **complementary purposes**:
- **mcp-cli**: Quick tool interaction, scripting, AI agent support
- **routermcp**: Enterprise gateway with security, filtering, session management

By adopting mcp-cli's interactive features, routermcp can provide the best of both worlds.

## Task Priority Matrix

| Task | Priority | Effort | Impact |
|------|----------|--------|--------|
| [001-interactive-tool-discovery](./001-interactive-tool-discovery.md) | 🔴 High | Medium | High |
| [002-standalone-binary-distribution](./002-standalone-binary-distribution.md) | 🟡 Medium | Small | Medium |
| [003-semantic-exit-codes](./003-semantic-exit-codes.md) | 🔴 High | Small | High |
| [004-json-output-mode](./004-json-output-mode.md) | 🔴 High | Small | High |
| [005-connection-retry-logic](./005-connection-retry-logic.md) | 🟡 Medium | Small | Medium |
| [006-ai-agent-integration](./006-ai-agent-integration.md) | 🟡 Medium | Small | Medium |

## Already Implemented (No Task Needed)

### ✅ Worker Pool / Concurrency Control
`src/core/upstream.ts:81-102` - Batch processing with configurable concurrency.

### ✅ Lazy Connection / Wake-on-Call
`src/core/upstream.ts:226-294` - `ensureConnected()` connects on-demand, `resetIdleTimer()` auto-disconnects after idle timeout.

### ✅ Capability Caching
Servers cache tools/resources/prompts after discovery, no refetch needed on reconnect.

## Recommended Implementation Order

### Phase 1: Core CLI Improvements (Week 1-2)
1. **Task 003**: Semantic exit codes - Foundation for scripting
2. **Task 004**: JSON output mode - Enable shell composability
3. **Task 001**: Interactive commands - list, search, info, call

### Phase 2: Reliability & Distribution (Week 3)
4. **Task 005**: Retry logic - Improve reliability
5. **Task 002**: Binary distribution - Easy installation
6. **Task 006**: AI agent integration - SKILL.md and minimal output

## Feature Comparison Matrix

| Feature | mcp-cli | routermcp | After Tasks |
|---------|---------|-----------|-------------|
| List tools | ✅ | ❌ | ✅ Task 001 |
| Search tools | ✅ | ❌ | ✅ Task 001 |
| Show tool schema | ✅ | ❌ | ✅ Task 001 |
| Direct tool call | ✅ | ❌ | ✅ Task 001 |
| JSON output | ✅ | ❌ | ✅ Task 004 |
| Semantic exit codes | ✅ | ❌ | ✅ Task 003 |
| Retry logic | ✅ | Partial | ✅ Task 005 |
| Binary distribution | ✅ | ❌ | ✅ Task 002 |
| SKILL.md | ✅ | ❌ | ✅ Task 006 |
| Gateway mode | ❌ | ✅ | ✅ |
| Tool filtering | ❌ | ✅ | ✅ |
| Session management | ❌ | ✅ | ✅ |
| Daemon mode | ❌ | ✅ | ✅ |
| Code Mode | ❌ | ✅ | ✅ |
| OpenAPI support | ❌ | ✅ | ✅ |
| OAuth | ❌ | ✅ | ✅ |
| Tunnels | ❌ | ✅ | ✅ |
| Lazy connection | ❌ | ✅ | ✅ |
| Idle timeout | ❌ | ✅ | ✅ |
| Capability caching | ❌ | ✅ | ✅ |

## Architecture After Improvements

```
routermcp
├── Gateway Mode (existing)
│   ├── serve     - Start MCP gateway
│   ├── connect   - Connect to daemon
│   ├── proxy     - Stdio-to-HTTP proxy
│   ├── tunnel    - Expose via tunnel
│   └── doctor    - Config & OAuth check
│
├── Interactive Mode (NEW - Task 001)
│   ├── list      - List all tools
│   ├── search    - Search tools by pattern
│   ├── info      - Show tool/server details
│   └── call      - Execute tool directly
│
├── Management
│   ├── config    - Configuration wizard
│   ├── oauth     - Token management
│   └── telemetry - Analytics control
│
└── Output (NEW - Tasks 003, 004)
    ├── --json    - Machine-readable output
    ├── --minimal - Compact for AI agents
    └── Exit codes: 0/1/2/3
```

## Estimated Total Effort

- **Phase 1**: 5-7 days
- **Phase 2**: 3-4 days
- **Total**: ~2 weeks

## References

- mcp-cli repository: https://github.com/philschmid/mcp-cli
- mcp-cli documentation: https://deepwiki.com/philschmid/mcp-cli
- routermcp-cli: /home/zyber/PROJECTS/TEMP/routermcp/packages/cli
