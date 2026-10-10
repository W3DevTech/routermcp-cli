import type { SandboxOptions } from "@sebastianwessel/quickjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GroupedTool } from "./codegen.js";

export interface ToolCallDispatcher {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

type CodeModeToolReference = string | GroupedTool;

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration: number;
}

export interface CodeModeResult {
  success: boolean;
  result: unknown;
  logs: string[];
  errors: string[];
  toolCalls: ToolCallRecord[];
  duration: number;
}

export interface SandboxConfig {
  timeout?: number;
  allowFetch?: boolean;
}

interface QuickJsSandboxResult {
  ok: boolean;
  data?: unknown;
  error?: { message: string };
}

type QuickJsLoader = Awaited<ReturnType<typeof import("@sebastianwessel/quickjs").loadQuickJs>>;

let quickJsLoader: QuickJsLoader | null = null;

async function getQuickJsLoader(): Promise<QuickJsLoader> {
  if (!quickJsLoader) {
    const { loadQuickJs } = await import("@sebastianwessel/quickjs");
    const variant = (await import("@jitl/quickjs-ng-wasmfile-release-sync")).default;
    quickJsLoader = await loadQuickJs(variant);
  }
  return quickJsLoader;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return `Error: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function executeCodeMode(
  code: string,
  aggregator: ToolCallDispatcher,
  toolsByServer: ReadonlyMap<string, readonly CodeModeToolReference[]>,
  config: SandboxConfig = {},
): Promise<CodeModeResult> {
  const { timeout = 30000, allowFetch = true } = config;
  const logs: string[] = [];
  const errors: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const startTime = Date.now();

  const { runSandboxed } = await getQuickJsLoader();

  const toolNamespaces: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {};

  for (const [serverName, tools] of toolsByServer) {
    toolNamespaces[serverName] = {};
    for (const reference of tools) {
      const tool =
        typeof reference === "string"
          ? { name: reference, callableName: reference }
          : reference;
      toolNamespaces[serverName][tool.name] = async (args: unknown) => {
        const start = Date.now();
        try {
          const result = await aggregator.callTool(
            tool.callableName,
            (args ?? {}) as Record<string, unknown>,
          );
          toolCalls.push({
            tool: `${serverName}.${tool.name}`,
            args,
            result,
            duration: Date.now() - start,
          });
          return result;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          toolCalls.push({
            tool: `${serverName}.${tool.name}`,
            args,
            error: errorMsg,
            duration: Date.now() - start,
          });
          throw err;
        }
      };
    }
  }

  const serverNames = [...toolsByServer.keys()];
  const destructureStatement =
    serverNames.length > 0 ? `const { ${serverNames.join(", ")} } = env;\n` : "";

  const wrappedCode = `
${destructureStatement}
const __main = async () => {
${code}
};
export default await __main();
`;

  const options: SandboxOptions = {
    allowFetch,
    allowFs: false,
    env: toolNamespaces,
    console: {
      log: (...args: unknown[]) => logs.push(args.map(formatValue).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map(formatValue).join(" ")),
      warn: (...args: unknown[]) => logs.push(`[WARN] ${args.map(formatValue).join(" ")}`),
      info: (...args: unknown[]) => logs.push(`[INFO] ${args.map(formatValue).join(" ")}`),
    },
    executionTimeout: timeout,
  };

  try {
    const result = (await runSandboxed(
      async ({ evalCode }: { evalCode: (code: string) => Promise<unknown> }) =>
        evalCode(wrappedCode),
      options,
    )) as QuickJsSandboxResult;

    if (result.ok) {
      return {
        success: true,
        result: result.data,
        logs,
        errors,
        toolCalls,
        duration: Date.now() - startTime,
      };
    }
    return {
      success: false,
      result: null,
      logs,
      errors: [...errors, result.error?.message || "Unknown error"],
      toolCalls,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      logs,
      errors: [...errors, err instanceof Error ? err.message : String(err)],
      toolCalls,
      duration: Date.now() - startTime,
    };
  }
}
