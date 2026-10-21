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

When enabled, RouterMCP sends an **anonymous error report** only when the CLI
exits with a fatal error. Nothing is sent during normal operation.

**Collected:**
- Error name, code, message and stack trace, after redaction (see below)
- CLI command used (e.g., `serve`, `connect`)
- Flag names passed on the command line (e.g., `--http`, `--config`), never their values
- RouterMCP version
- Node.js/Bun version, operating system and CPU architecture
- A random ID generated per process, so events from one run can be grouped

**Redacted before sending:**
- Every argument value: `routermcp serve --config ./a.jsonc --stdio "npx x --token y"`
  is reported as `--config <redacted> --stdio <redacted>`
- Your home directory in messages and stack traces (replaced with `~`)
- URL credentials, query strings and fragments
- `Bearer`/`Basic` credentials and `token=`, `secret=`, `password=`, `api_key=`-style values

**NOT Collected:**
- Configuration file contents
- Credentials or OAuth tokens
- Tool names, tool arguments or tool results
- Any user data or file contents
- IP addresses (anonymized by infrastructure)

Redaction is best-effort pattern matching. If an error message could contain
something you consider sensitive, disable telemetry.

Reports are sent to `https://telemetry.routermcp.com/v1/ingest`. The code is in
[`src/telemetry/`](../../src/telemetry/).

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

Setting the [`DO_NOT_TRACK`](https://consoledonottrack.com) environment variable
to any value other than `0` or `false` disables telemetry regardless of the
stored preference:

```bash
export DO_NOT_TRACK=1
```

## Why Telemetry?

Anonymous telemetry helps:
- Identify common errors and crashes
- Prioritize bug fixes
- Improve overall stability

We respect your privacy and only collect what's needed to improve the tool.

---

**Previous**: [oauth](oauth.md) | **Up**: [Commands](../index.md)
