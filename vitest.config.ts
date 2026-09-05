import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.spec.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 30000,
    hookTimeout: 120000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli/serve.ts",
        "src/cli/connect.ts",
        "src/cli/daemon.ts",
        "src/cli/config.ts",
        "src/cli/tunnel.ts",
        "src/cli/proxy.ts",
        "src/cli/doctor.ts",
        "src/cli/oauth.ts",
        "src/index.ts",
        "src/daemon/**",
        "src/tunnel/**",
        "src/oauth/**",
        "src/proxy/**",
        "src/transports/**",
        "src/compat/**",
        "src/openapi/**",
        "src/core/gateway.ts",
        "src/core/upstream.ts",
        "src/core/virtual-session.ts",
        "src/core/session-counter.ts",
        "src/core/codemode/meta-tools.ts",
        "src/core/codemode/index.ts",
        "src/config/index.ts",
        "src/config/types.ts",
        "src/filtering/index.ts",
        "src/utils/credentials.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 75,
        statements: 75,
      },
    },
    poolOptions: {
      threads: {
        useAtomics: true,
      },
    },
    typecheck: {
      enabled: false,
    },
  },
  plugins: [tsconfigPaths()],
});
