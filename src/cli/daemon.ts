import { resolve } from "node:path";
import { resolveConfigFromPath } from "../config/loader.js";
import {
  fingerprintConfigFile,
  getDaemonPaths,
  getProjectId,
  ensureWorkspaceRunning,
  getWorkspaceDaemonStatus,
  restartWorkspaceDaemon,
  stopWorkspaceDaemon,
  type DaemonStatus,
} from "../daemon/index.js";

export interface DaemonCommandOptions {
  config?: string;
  project?: string;
  host?: string;
  preferredPort?: number;
  verbose?: boolean;
  json?: boolean;
}

export async function startCommand(options: DaemonCommandOptions): Promise<void> {
  const context = await resolveDaemonContext(options);
  const status = await ensureWorkspaceRunning(context.workspace, {
    configFingerprint: context.configFingerprint,
    projectPath: context.projectPath,
    host: options.host ?? context.configuredHost,
    preferredPort: options.preferredPort ?? context.configuredPort,
    verbose: options.verbose,
  });
  printStatus(status, options.json);
}

export async function statusCommand(options: DaemonCommandOptions): Promise<void> {
  const context = await resolveDaemonContext(options);
  const status = await getWorkspaceDaemonStatus(context.workspace, {
    healthTimeoutMs: 1_000,
  });
  printStatus(status, options.json);
}

export async function stopCommand(options: DaemonCommandOptions): Promise<void> {
  const context = await resolveDaemonContext(options);
  await stopWorkspaceDaemon(context.workspace);
  const status: DaemonStatus = {
    running: false,
    state: "stopped",
    profileId: context.paths.profileId,
  };
  printStatus(status, options.json);
}

export async function restartCommand(options: DaemonCommandOptions): Promise<void> {
  const context = await resolveDaemonContext(options);
  const status = await restartWorkspaceDaemon(context.workspace, {
    configFingerprint: context.configFingerprint,
    projectPath: context.projectPath,
    host: options.host ?? context.configuredHost,
    preferredPort: options.preferredPort ?? context.configuredPort,
    verbose: options.verbose,
  });
  printStatus(status, options.json);
}

export interface DaemonContext {
  configFingerprint: string;
  configPath: string;
  configScope: import("../config/types.js").ConfigScope;
  configuredHost?: string;
  configuredPort?: number;
  paths: ReturnType<typeof getDaemonPaths>;
  projectPath: string;
  workspace: {
    directory: string;
    configPath: string;
    configScope: import("../config/types.js").ConfigScope;
    configDigest: string;
  };
}

export async function resolveDaemonContext(options: DaemonCommandOptions): Promise<DaemonContext> {
  const projectPath = resolve(options.project ?? process.cwd());
  const resolved = await resolveConfigFromPath(options.config, projectPath);
  const configPath = resolve(resolved.path);
  const projectId = getProjectId(projectPath);
  const paths = getDaemonPaths(projectId, configPath, projectPath);
  const configFingerprint = await fingerprintConfigFile(configPath);
  return {
    configFingerprint,
    configPath,
    configScope: resolved.scope,
    configuredHost: resolved.config.httpServer?.host,
    configuredPort: resolved.config.httpServer?.port,
    paths,
    projectPath,
    workspace: {
      directory: projectPath,
      configPath,
      configScope: resolved.scope,
      configDigest: configFingerprint,
    },
  };
}

function printStatus(status: DaemonStatus, json = false): void {
  if (json) {
    console.log(JSON.stringify(status.manifest ?? status, null, 2));
    return;
  }

  if (status.running) {
    const address = status.port ? `http://${status.host ?? "127.0.0.1"}:${status.port}` : "unknown";
    console.log(`RouterMCP daemon running (pid ${status.pid}, ${address})`);
    return;
  }

  console.log(`RouterMCP daemon stopped${status.reason ? `: ${status.reason}` : ""}`);
}
