# Copilot Instructions for RouterMCP CLI

## Project Overview

RouterMCP is a Bun-based CLI MCP Gateway that aggregates multiple upstream MCP servers into a single unified interface with comprehensive tool/resource/prompt filtering capabilities. It's written in TypeScript and uses the Model Context Protocol (MCP) SDK.

## Project Architecture

```
src/
├── index.ts           # CLI entry point (shebang, env setup, dynamic imports)
├── cli/               # CLI commands and argument parsing
│   ├── index.ts       # Main CLI entry point, argument parser
│   ├── serve.ts       # Serve command implementation
│   ├── config.ts      # Interactive configuration wizard
│   └── tunnel.ts      # Tunnel command for exposing gateway
├── config/            # Configuration loading and validation
│   ├── index.ts       # Exports
│   ├── loader.ts      # JSONC config file loading with env var substitution
│   ├── schema.ts      # Zod schemas for validation
│   └── types.ts       # TypeScript types for configuration
├── core/              # Gateway, upstream management, aggregation
│   ├── gateway.ts     # Main Gateway class
│   ├── upstream.ts    # UpstreamManager for connecting to MCP servers
│   └── aggregator.ts  # Aggregates tools/resources/prompts from upstreams
├── transports/        # Stdio and HTTP transport implementations
├── filtering/         # Tool/resource/prompt filtering logic with glob patterns
├── tunnel/            # Tunnel providers (cloudflare, ngrok)
└── utils/             # Error types and utilities
```

## Build, Test, and Development Commands

```bash
# Install dependencies (prefer bun if available, npm works too)
bun install
# or
npm install

# Type checking
bun run typecheck
# or
npx tsc --noEmit

# Build for production
bun run build

# Run in development mode (with watch)
bun run dev

# Run directly
bun run src/index.ts --help
```

**Note:** This project uses Bun as the primary runtime. If Bun is not available, npm/npx commands will work for development.

## Coding Conventions

### TypeScript Style

- Use ES2022+ features with ESNext modules
- Strict TypeScript mode is enabled
- Use explicit type annotations for function parameters and return types
- Use `type` imports when importing only types: `import type { ... } from "..."`
- Use `.js` extension in imports (for ESM compatibility): `import { foo } from "./bar.js"`

### Code Organization

- Each module should have a clear single responsibility
- Export types and interfaces from dedicated `types.ts` files
- Use `index.ts` files for clean re-exports from directories
- Place schema definitions using Zod in `schema.ts` files

### Naming Conventions

- Use PascalCase for classes, interfaces, and type aliases
- Use camelCase for variables, functions, and methods
- Use SCREAMING_SNAKE_CASE for constants
- Suffix interfaces with descriptive names (e.g., `GatewayOptions`, `ServerConfig`)

### Error Handling

- Use descriptive error messages that help users understand the issue
- Log to stderr for CLI output (use `console.error`)
- Use `process.exit(1)` for fatal errors in CLI commands
- Implement graceful degradation where possible (e.g., continue if one upstream fails)

### Documentation

- Add JSDoc comments for public classes, functions, and interfaces
- Use `/** */` style for documentation comments
- Include `@param` and `@returns` tags where applicable

## Configuration File Format

RouterMCP uses JSONC (JSON with Comments) configuration files. The configuration schema is defined using Zod in `src/config/schema.ts`.

Key configuration concepts:
- Transport type is auto-detected from config keys (`command` → stdio, `url` → http)
- Environment variables use `${VAR_NAME}` syntax
- Filtering uses exact match lists and glob patterns

## Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol SDK
- `@clack/prompts` - Interactive CLI prompts
- `zod` - Runtime type validation
- `micromatch` - Glob pattern matching
- `jsonc-parser` - JSONC file parsing

## Security Boundaries

When making changes to this codebase:

- **Never commit secrets** or API keys to the repository
- **Never modify** the filtering logic to bypass security controls
- **Always validate** user input, especially in configuration parsing
- **Be careful** with environment variable substitution - don't log sensitive values
- **Don't expose** internal implementation details in error messages

## Common Tasks

### Adding a New CLI Command

1. Create a new file in `src/cli/` (e.g., `newcommand.ts`)
2. Export a command function that takes options and returns `Promise<void>`
3. Add the command to the parser in `src/cli/index.ts`
4. Update the help text in `printHelp()`

### Adding a New Filter Type

1. Add the filter fields to `FilterFieldsSchema` in `src/config/schema.ts`
2. Update the types in `src/config/types.ts`
3. Implement the filtering logic in `src/filtering/`
4. Update the aggregator to use the new filter

### Adding a New Tunnel Provider

1. Create a new file in `src/tunnel/` for the provider
2. Implement the tunnel provider interface
3. Register the provider in `src/tunnel/index.ts`
4. Update CLI help text with the new provider option

## Testing Approach

This project currently relies on type checking (`tsc --noEmit`) for validation. When adding tests:

- Place tests alongside source files or in a `__tests__` directory
- Use Bun's built-in test runner
- Focus on testing filtering logic and configuration parsing

## Pull Request Guidelines

- Keep changes focused and minimal
- Update documentation if adding new features
- Ensure type checking passes before submitting
- Test CLI commands manually with various configurations
