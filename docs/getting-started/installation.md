---
title: Installation
description: Install RouterMCP CLI globally or locally
---

# Installation

RouterMCP CLI can be installed globally for system-wide access or locally per-project.

## Prerequisites

- Node.js 18+ or Bun 1.0+
- npm, yarn, pnpm, or bun package manager

## Global Installation

Install RouterMCP globally to use it from anywhere:

```bash
npm install -g routermcp
```

After global installation, use the `routermcp` command directly:

```bash
routermcp --help
```

## Local Installation

Install RouterMCP as a project dependency:

```bash
npm install routermcp
```

Use with npx:

```bash
npx routermcp --help
```

Or add to your package.json scripts:

```json
{
  "scripts": {
    "mcp": "routermcp",
    "mcp:serve": "routermcp serve",
    "mcp:config": "routermcp config"
  }
}
```

Then run:

```bash
npm run mcp
```

## Using with Bun

If you prefer Bun:

```bash
# Global
bun install -g routermcp

# Local
bun add routermcp

# Run
bunx routermcp --help
```

## Verify Installation

Check that RouterMCP is installed correctly:

```bash
routermcp --help
```

You should see the help output with available commands.

## Next Steps

- [Quick Start](quick-start.md) - Get a gateway running in 5 minutes
- [First Configuration](first-config.md) - Understand the config file

---

**Next**: [Quick Start](quick-start.md)
