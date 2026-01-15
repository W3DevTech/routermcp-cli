# Task 002: Standalone Binary Distribution

## Summary

Add cross-platform binary compilation and distribution, enabling single-file installation without Node.js or Bun runtime dependencies.

## Background

The `mcp-cli` project compiles to standalone executables for 5 platforms using Bun's `--compile` flag. This allows:
- Zero-dependency installation
- Simple curl-based installation script
- Consistent behavior across environments
- Easier distribution to non-developers

Currently, `routermcp` requires `npx routermcp` or `bunx routermcp` which needs a Node.js/Bun runtime.

## Proposed Implementation

### 1. Build Scripts

Add build scripts to `package.json`:

```json
{
  "scripts": {
    "build:binary": "bun build src/index.ts --compile --minify --outfile dist/routermcp",
    "build:linux": "bun build src/index.ts --compile --minify --target bun-linux-x64 --outfile dist/routermcp-linux-x64",
    "build:linux-arm": "bun build src/index.ts --compile --minify --target bun-linux-arm64 --outfile dist/routermcp-linux-arm64",
    "build:macos": "bun build src/index.ts --compile --minify --target bun-darwin-x64 --outfile dist/routermcp-darwin-x64",
    "build:macos-arm": "bun build src/index.ts --compile --minify --target bun-darwin-arm64 --outfile dist/routermcp-darwin-arm64",
    "build:windows": "bun build src/index.ts --compile --minify --target bun-windows-x64 --outfile dist/routermcp-windows-x64.exe",
    "build:all": "bun run build:linux && bun run build:linux-arm && bun run build:macos && bun run build:macos-arm && bun run build:windows"
  }
}
```

### 2. Installation Script

Create `install.sh` for easy installation:

```bash
#!/bin/bash
# Detect platform and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

BINARY="routermcp-${OS}-${ARCH}"
INSTALL_DIR="${HOME}/.local/bin"

# Download from GitHub releases
curl -fsSL "https://github.com/W3mirror/routermcp-cli/releases/latest/download/${BINARY}" \
  -o "${INSTALL_DIR}/routermcp"
chmod +x "${INSTALL_DIR}/routermcp"

echo "routermcp installed to ${INSTALL_DIR}/routermcp"
```

### 3. Version Management

Create `src/version.ts`:

```typescript
// Auto-updated by release script
export const VERSION = "0.1.9";
```

Add `--version` flag handling:

```typescript
case "--version":
case "-V":
  console.log(`routermcp v${VERSION}`);
  process.exit(0);
```

### 4. GitHub Actions for Releases

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target:
          - bun-linux-x64
          - bun-linux-arm64
          - bun-darwin-x64
          - bun-darwin-arm64
          - bun-windows-x64
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun build src/index.ts --compile --minify --target ${{ matrix.target }} --outfile dist/routermcp-${{ matrix.target }}
      - uses: softprops/action-gh-release@v1
        with:
          files: dist/*
```

### 5. Checksum Generation

Generate checksums for security:

```bash
cd dist
sha256sum routermcp-* > checksums.txt
```

## Platform Support Matrix

| Platform | Architecture | Binary Name |
|----------|--------------|-------------|
| Linux | x64 | routermcp-linux-x64 |
| Linux | ARM64 | routermcp-linux-arm64 |
| macOS | x64 (Intel) | routermcp-darwin-x64 |
| macOS | ARM64 (Apple Silicon) | routermcp-darwin-arm64 |
| Windows | x64 | routermcp-windows-x64.exe |

## Installation Methods

After implementation, users can install via:

```bash
# Quick install (recommended)
curl -fsSL https://raw.githubusercontent.com/W3mirror/routermcp-cli/main/install.sh | bash

# Manual download
wget https://github.com/W3mirror/routermcp-cli/releases/latest/download/routermcp-linux-x64
chmod +x routermcp-linux-x64
mv routermcp-linux-x64 ~/.local/bin/routermcp

# npm (still works)
npm install -g routermcp

# bun (still works)
bun install -g routermcp
```

## Benefits

1. **Zero dependencies** - No runtime required
2. **Fast startup** - No module resolution overhead
3. **Easy distribution** - Single file to copy/download
4. **CI/CD friendly** - Simple to integrate in pipelines
5. **Air-gapped environments** - Works without internet access after download

## Estimated Effort

- **Size**: Small (1-2 days)
- **Priority**: Medium
- **Dependencies**: None

## References

- Bun compile documentation: https://bun.sh/docs/bundler/executables
- mcp-cli build scripts: https://github.com/philschmid/mcp-cli/blob/main/package.json
