---
title: telemetry Command
description: Control anonymous error reporting
---

# telemetry Command

Manage anonymous telemetry for error reporting and improvement.

## Usage

```bash
routermcp telemetry                 # Show current status
routermcp telemetry status          # Show current status
routermcp telemetry enable          # Enable telemetry
routermcp telemetry disable         # Disable telemetry
```

## What Is Collected

When enabled, RouterMCP collects **anonymous error reports** to help improve the tool:

**Collected:**
- Error messages and stack traces
- CLI command used (e.g., `serve`, `connect`)
- RouterMCP version
- Node.js/Bun version
- Operating system type

**NOT Collected:**
- Configuration file contents
- Server URLs or credentials
- Tool names or arguments
- Any user data or file contents
- IP addresses (anonymized by infrastructure)

## Status

```bash
$ routermcp telemetry status

Telemetry Status: Enabled
  - Anonymous error reports are sent to help improve RouterMCP
  - No personal data or configuration is collected
  - Run 'routermcp telemetry disable' to opt out
```

## Enable

```bash
$ routermcp telemetry enable

Telemetry enabled.
Thank you for helping improve RouterMCP!
```

## Disable

```bash
$ routermcp telemetry disable

Telemetry disabled.
No anonymous data will be collected.
```

## Configuration File

Telemetry preference is stored in:

| Platform | Location |
|----------|----------|
| Linux | `~/.config/routermcp/telemetry.json` |
| macOS | `~/.config/routermcp/telemetry.json` |
| Windows | `%APPDATA%\routermcp\telemetry.json` |

Contents:
```json
{
  "enabled": true
}
```

## Default Behavior

By default, telemetry is **enabled** to help improve RouterMCP. You can opt out at any time with `routermcp telemetry disable`.

## Why Telemetry?

Anonymous telemetry helps:
- Identify common errors and crashes
- Prioritize bug fixes
- Understand which features are used
- Improve overall stability

We respect your privacy and only collect what's needed to improve the tool.

---

**Previous**: [oauth](oauth.md) | **Up**: [Commands](../index.md)
