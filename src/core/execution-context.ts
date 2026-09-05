import { resolve } from "node:path";

/**
 * Process inputs owned by one RouterMCP workspace.
 *
 * A managed daemon can host more than one workspace, so code that starts an
 * upstream must use these values instead of process.cwd()/process.env. The
 * environment is a private snapshot and callers must treat it as immutable.
 */
export interface RuntimeExecutionContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RuntimeExecutionContextInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/** Create a normalized, private execution context without changing globals. */
export function createRuntimeExecutionContext(
  input: RuntimeExecutionContextInput = {},
  baseDirectory = process.cwd(),
): RuntimeExecutionContext {
  const cwd = resolve(baseDirectory, input.cwd ?? ".");
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return {
    cwd,
    env: Object.freeze(env),
  };
}

/** Resolve a path from a workspace context, preserving absolute paths. */
export function resolveRuntimePath(path: string, context: RuntimeExecutionContext): string {
  return resolve(context.cwd, path);
}
