import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { getScopeLabel, loadConfig, resolveConfigFromPath } from "../config/loader.js";
import type { RouterMcpConfig } from "../config/types.js";
import { createGateway, type Gateway } from "../core/gateway.js";
import type { UpstreamServer } from "../core/upstream.js";
import {
  createHttpServerTransport,
  type HttpRequestContext,
  type HttpServerHandle,
} from "../transports/http-streamable.js";
import {
  ControlPlane,
  ManagementCredentialStore,
  createConfigManagementSource,
  getExecutionMode,
  sanitizeText,
  sanitizeUrl,
  type ControlPlaneServer,
  type ControlPlaneSession,
  type ControlPlaneStatus,
  type ControlPlaneWorkspaceStatus,
} from "../control-plane/index.js";
import {
  DAEMON_HOST_CAPABILITIES,
  DAEMON_HOST_CAPABILITY_VERSION,
  DAEMON_HOST_MANIFEST_PROTOCOL_VERSION,
  type DaemonPaths,
  acquireProfileLock,
  createRuntimeManifest,
  createReadinessSnapshot,
  fingerprintConfigFile,
  getDaemonStatus,
  getDaemonPaths,
  getProjectId,
  isLoopbackHost,
  matchesProcessIdentity,
  readRuntimeManifest,
  removeRuntimeManifest,
  type RuntimeManifest,
  transitionReadiness,
  type WorkspaceRegistrationInput,
  WorkspaceLeaseTracker,
  WorkspaceRegistry,
  WorkspaceRuntimeManager,
  type WorkspaceRuntimeInput,
  type WorkspaceSnapshot,
  writeRuntimeManifest,
} from "../daemon/index.js";
import { buildRuntimeInvocation } from "../daemon/lifecycle.js";
import { ConfigError, RouterMcpError } from "../utils/errors.js";
import { configCommand } from "./config.js";

export interface ServeCommandOptions {
  config?: string;
  stdio?: boolean;
  http?: number;
  host?: string;
  verbose?: boolean;
  daemonMode?: boolean;
  project?: string;
  socket?: string;
  clearCache?: boolean;
}

const DEFAULT_DAEMON_PORT = 7858;
const MANAGED_RESTART_TIMEOUT_MS = 30_000;
/** Internal-only handoff used by a controlled restart to retain bridge auth. */
const MANAGED_RESTART_AUTH_TOKEN_ENV = "ROUTERMCP_DAEMON_RESTART_AUTH_TOKEN";
const LOCAL_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function serveCommand(options: ServeCommandOptions): Promise<void> {
  const verbose = options.verbose ?? false;
  const isDaemon = options.daemonMode ?? false;
  const clearCache = options.clearCache ?? false;

  let mode: "stdio" | "http-streamable" = options.http ? "http-streamable" : "stdio";
  let httpPort = options.http;

  if (isDaemon) {
    mode = "http-streamable";
    httpPort = httpPort ?? DEFAULT_DAEMON_PORT;
  }

  let daemonPaths: DaemonPaths | null = null;
  let runtimeManifest: RuntimeManifest | null = null;
  let gateway: Gateway | null = null;
  let controlPlane: ControlPlane | null = null;
  let managementCredentials: ManagementCredentialStore | null = null;
  let workspaceRegistry: WorkspaceRegistry | null = null;
  let workspaceLeaseTracker: WorkspaceLeaseTracker | null = null;
  let workspaceRuntimeManager: WorkspaceRuntimeManager | null = null;
  let hostHttpServer: HttpServerHandle | null = null;
  let currentWorkspace: WorkspaceSnapshot | null = null;
  let currentWorkspaceRegistration: WorkspaceRegistrationInput | null = null;
  let configFingerprint: string | undefined;
  let desiredConfig: RouterMcpConfig | null = null;
  let desiredConfigRevision: string | undefined;
  const desiredServerLastChangedAt = new Map<string, string>();
  const sessionWorkspaceIds = new Map<string, string>();
  const workspaceActivations = new Map<string, Promise<void>>();
  let restartScheduled = false;
  let startupLock: Awaited<ReturnType<typeof acquireProfileLock>> | null = null;

  try {
    if (options.socket) {
      throw new RouterMcpError(
        "Unix socket transport is not available; use the managed loopback HTTP transport",
        "UNSUPPORTED_SOCKET_TRANSPORT",
      );
    }

    const { config, path: configPath, scope } = await resolveConfigFromPath(options.config);
    desiredConfig = config;

    if (verbose) {
      console.error(`Loaded config from: ${configPath} [${getScopeLabel(scope)}]`);
      console.error(`Configured servers: ${Object.keys(config.mcpServers).join(", ")}`);
    }

    if (isDaemon) {
      httpPort = options.http ?? config.httpServer?.port ?? DEFAULT_DAEMON_PORT;
    }

    if (isDaemon) {
      const projectPath = resolve(options.project ?? process.cwd());
      const daemonHost = options.host ?? config.httpServer?.host ?? "127.0.0.1";
      if (!isLoopbackHost(daemonHost)) {
        throw new RouterMcpError(
          `Daemon host must be loopback (received ${daemonHost})`,
          "INVALID_DAEMON_HOST",
        );
      }
      const projectId = getProjectId(projectPath);
      daemonPaths = getDaemonPaths(projectId, resolve(configPath), projectPath);
      if (daemonPaths.runtimeManifest) {
        configFingerprint = await fingerprintConfigFile(daemonPaths.configPath);
        desiredConfigRevision = configFingerprint;
        workspaceRegistry = new WorkspaceRegistry();
        currentWorkspaceRegistration = {
          directory: projectPath,
          configPath: daemonPaths.configPath,
          configScope: scope,
          configDigest: configFingerprint,
        };
        currentWorkspace = await workspaceRegistry.ensure(currentWorkspaceRegistration);
        workspaceLeaseTracker = new WorkspaceLeaseTracker(workspaceRegistry);
      } else {
        // Compatibility callers can provide the pre-manifest DaemonPaths
        // shape. They retain the legacy pid/port lifecycle and have no
        // workspace registry until they migrate to runtime.json.
        configFingerprint = undefined;
      }

      // The supervisor keeps this lock while the child reaches ready. A
      // manually launched daemon must acquire it itself so two direct
      // `serve --daemon-mode` invocations cannot overwrite one profile.
      if (process.env.ROUTERMCP_DAEMON_LOCK_HELD !== "1") {
        startupLock = await acquireProfileLock(daemonPaths.lock);
        const incumbent = await getDaemonStatus(daemonPaths);
        const incumbentManifest = daemonPaths.runtimeManifest
          ? await readRuntimeManifest(daemonPaths.runtimeManifest)
          : null;
        const incumbentAlive = incumbentManifest
          ? await matchesProcessIdentity(incumbentManifest.processIdentity)
          : incumbent.running;
        if (incumbentAlive) {
          await startupLock.release();
          startupLock = null;
          throw new Error(
            `RouterMCP daemon is already running for this profile (pid ${incumbentManifest?.pid ?? incumbent.pid ?? "unknown"})`,
          );
        }

        if (incumbentManifest && daemonPaths.runtimeManifest) {
          await removeRuntimeManifest(daemonPaths.runtimeManifest);
        }
      }

      if (daemonPaths.runtimeManifest) {
        const inheritedAuthToken = readManagedRestartAuthToken();
        runtimeManifest = await createRuntimeManifest({
          projectId,
          profileId: daemonPaths.profileId,
          configPath: daemonPaths.configPath,
          configFingerprint: configFingerprint ?? (await fingerprintConfigFile(daemonPaths.configPath)),
          pid: process.pid,
          host: daemonHost,
          port: httpPort,
          localAuthToken: inheritedAuthToken ?? randomBytes(32).toString("base64url"),
        });
        await writeRuntimeManifest(daemonPaths.runtimeManifest, runtimeManifest);
      } else {
        // Compatibility path for callers with a pre-contract DaemonPaths
        // object. Production paths always use runtime.json.
        mkdirSync(daemonPaths.dir, { recursive: true });
        writeFileSync(daemonPaths.pid, String(process.pid));
      }

      if (verbose) {
        console.error(`[daemon] Project ID: ${projectId}`);
        console.error(
          `[daemon] Runtime manifest: ${daemonPaths.runtimeManifest ?? daemonPaths.pid}`,
        );
      }

      const workspaceConfigs = new Map<
        string,
        { config: RouterMcpConfig; configDigest: string }
      >();
      const workspaceManagement = new Map<
        string,
        ReturnType<typeof createConfigManagementSource>
      >();
      if (currentWorkspace) {
        workspaceConfigs.set(currentWorkspace.id, {
          config,
          configDigest: currentWorkspace.configDigest,
        });
      }

      const loadWorkspaceConfigSnapshot = async (
        workspace: WorkspaceSnapshot,
      ): Promise<{ config: RouterMcpConfig; configDigest: string }> => {
        const workspaceConfig = await loadConfig(workspace.configPath, { env: process.env });
        const digest = await fingerprintConfigFile(workspace.configPath).catch(
          () => workspace.configDigest,
        );
        workspaceConfigs.set(workspace.id, { config: workspaceConfig, configDigest: digest });
        return { config: workspaceConfig, configDigest: digest };
      };

      const loadWorkspaceRuntimeInput = async (
        workspace: WorkspaceSnapshot,
      ): Promise<WorkspaceRuntimeInput> => {
        const { config: workspaceConfig, configDigest: digest } =
          await loadWorkspaceConfigSnapshot(workspace);
        return {
          directory: workspace.directory,
          configPath: workspace.configPath,
          config: workspaceConfig,
          configDigest: digest,
          cwd: workspace.directory,
          env: process.env,
        };
      };

      const reloadWorkspace = async (workspaceId: string) => {
        const workspace = workspaceRegistry?.getSync(workspaceId);
        if (!workspace || !workspaceRuntimeManager) {
          return {
            accepted: false,
            message: "Workspace runtime is not available",
            state: "offline" as const,
          };
        }

        try {
          const input = await loadWorkspaceRuntimeInput(workspace);
          await workspaceRuntimeManager.reload(input);
          return {
            accepted: true,
            message: "Workspace runtime reloaded",
            state: "ready" as const,
          };
        } catch {
          return {
            accepted: false,
            message: "Workspace configuration changed, but its runtime could not be reloaded",
            state: "failed" as const,
          };
        }
      };

      const getWorkspaceManagement = (workspaceId: string) => {
        const registry = workspaceRegistry;
        if (!registry) return null;
        const workspace = registry.getSync(workspaceId);
        if (!workspace) return null;

        const existing = workspaceManagement.get(workspaceId);
        if (existing) return existing;

        const management = createConfigManagementSource({
          getConfigPath: () => workspace.configPath,
          getEffectiveMode: async () => {
            const cached = workspaceConfigs.get(workspaceId);
            if (cached) return getExecutionMode(cached.config);
            const current = registry.getSync(workspaceId);
            if (!current) return getExecutionMode(config);
            const loaded = await loadConfig(current.configPath, { env: process.env });
            workspaceConfigs.set(workspaceId, {
              config: loaded,
              configDigest: current.configDigest,
            });
            return getExecutionMode(loaded);
          },
          getRestartState: () => ({ restartState: "idle" as const }),
          reload: () => reloadWorkspace(workspaceId),
          onAuditEvent: (event) => {
            controlPlane?.recordEvent({
              level: "info",
              type: `config.${event.type}`,
              message: event.message,
              workspaceId,
              metadata: { ...event.metadata, workspaceId },
            });
          },
          onMutation: async (mutation) => {
            workspaceConfigs.set(workspaceId, {
              config: mutation.config,
              configDigest: mutation.configDigest,
            });
            const current = registry.getSync(workspaceId);
            if (current) {
              await registry.ensure({
                directory: current.directory,
                configPath: current.configPath,
                configScope: current.configScope,
                configDigest: mutation.configDigest,
                workspaceId: current.id,
                profileId: current.profileId,
              });
            }
            if (currentWorkspace?.id === workspaceId) {
              desiredConfig = mutation.config;
              desiredConfigRevision = mutation.configDigest;
              currentWorkspace = {
                ...currentWorkspace,
                configDigest: mutation.configDigest,
                lastSeenAt: new Date().toISOString(),
              };
            }
          },
        });
        workspaceManagement.set(workspaceId, management);
        return management;
      };

      const getWorkspaceStatus = (
        workspaceId: string,
      ): ControlPlaneWorkspaceStatus | null => {
        const registry = workspaceRegistry;
        if (!registry) return null;
        const workspace = registry.getSync(workspaceId, {
          current: workspaceId === currentWorkspace?.id,
        });
        if (!workspace) return null;

        const runtime = workspaceRuntimeManager?.get(workspaceId);
        const runtimeSnapshot = workspaceRuntimeManager?.getSnapshot(workspaceId);
        const cached = workspaceConfigs.get(workspaceId);
        const workspaceMetrics =
          controlPlane?.getMetricsForWorkspace(workspaceId) ?? emptyControlPlaneMetrics();
        const status = {
          ...createControlPlaneStatus(
            runtimeManifest,
            runtime?.gateway ?? null,
            daemonPaths,
            httpPort,
            workspace,
            cached?.configDigest ?? workspace.configDigest,
            restartScheduled,
          ),
          // The listener identity belongs to the host, while this field is
          // the selected workspace's profile and must not expose the primary
          // workspace's config identity.
          profile: workspace.profileId,
        };
        const effectiveStatus = runtime
          ? status
          : {
              ...status,
              state:
                runtimeSnapshot?.state === "loading"
                  ? ("starting" as const)
                  : runtimeSnapshot?.state === "failed"
                    ? ("failed" as const)
                    : status.state === "ready"
                      ? ("offline" as const)
                      : status.state,
              ...(runtimeSnapshot?.lastError
                ? { restartMessage: runtimeSnapshot.lastError }
                : {}),
            };

        return {
          workspace,
          status: effectiveStatus,
          servers: createControlPlaneServers(
            runtime?.gateway ?? null,
            cached?.config ?? null,
            cached?.configDigest ?? workspace.configDigest,
            desiredServerLastChangedAt,
          ),
          sessions: runtime
            ? createControlPlaneSessions(
                runtime.gateway,
                runtimeManifest,
                sessionWorkspaceIds,
                workspace.profileId,
              )
            : [],
          metrics: {
            ...workspaceMetrics,
            activeSessions: runtime?.gateway.getSessionSnapshots().length ?? 0,
            activeLeases:
              workspaceLeaseTracker?.leases.filter((lease) => lease.workspaceId === workspaceId)
                .length ?? 0,
          },
        };
      };

      const getWorkspaceStatusAsync = async (
        workspaceId: string,
      ): Promise<ControlPlaneWorkspaceStatus | null> => {
        const workspace = workspaceRegistry?.getSync(workspaceId);
        if (!workspace) return null;

        // Registration is intentionally separate from runtime creation. Load
        // the desired config for management reads so a newly registered
        // workspace exposes its configured servers before its first MCP call.
        if (!workspaceConfigs.has(workspaceId)) {
          await loadWorkspaceConfigSnapshot(workspace);
        }
        return getWorkspaceStatus(workspaceId);
      };

      const activateWorkspace = async (workspaceId: string) => {
        const registry = workspaceRegistry;
        const runtimeManager = workspaceRuntimeManager;
        const workspace = registry?.getSync(workspaceId);
        if (!registry || !runtimeManager || !workspace) {
          return {
            workspaceId,
            state: "error" as const,
            message: "Workspace runtime is not available",
          };
        }

        const existing = runtimeManager.getSnapshot(workspaceId);
        if (existing?.state === "ready" || existing?.state === "idle") {
          return {
            workspaceId,
            state: "ready" as const,
            message: "Workspace runtime is ready",
          };
        }

        let activation = workspaceActivations.get(workspaceId);
        if (!activation) {
          activation = (async () => {
            try {
              const input = await loadWorkspaceRuntimeInput(workspace);
              await runtimeManager.getOrCreate(input);
            } catch (error) {
              await registry.markUnavailable(workspaceId, error).catch(() => undefined);
              throw error;
            }
          })();
          workspaceActivations.set(workspaceId, activation);
          // Activation is deliberately asynchronous so the control plane can
          // report `initializing` while a config or upstream is starting.
          void activation
            .catch(() => undefined)
            .finally(() => {
              if (workspaceActivations.get(workspaceId) === activation) {
                workspaceActivations.delete(workspaceId);
              }
            });
        }

        const snapshot = runtimeManager.getSnapshot(workspaceId);
        if (snapshot?.state === "ready" || snapshot?.state === "idle") {
          return {
            workspaceId,
            state: "ready" as const,
            message: "Workspace runtime is ready",
          };
        }
        if (snapshot?.state === "failed") {
          return {
            workspaceId,
            state: "error" as const,
            message: snapshot.lastError ?? "Workspace runtime failed to initialize",
          };
        }
        return {
          workspaceId,
          state: "initializing" as const,
          message: "Workspace runtime initialization started",
        };
      };

      controlPlane = new ControlPlane({
        getStatus: () =>
          createControlPlaneStatus(
            runtimeManifest,
            gateway,
            daemonPaths,
            httpPort,
            currentWorkspace,
            desiredConfigRevision,
            restartScheduled,
          ),
        getServers: () =>
          createControlPlaneServers(
            gateway,
            desiredConfig,
            desiredConfigRevision,
            desiredServerLastChangedAt,
          ),
        getSessions: () => createControlPlaneSessions(gateway, runtimeManifest, sessionWorkspaceIds),
        getLeases: () => workspaceLeaseTracker?.leases ?? gateway?.getConnectionLeases() ?? [],
        getCurrentWorkspaceId: () => currentWorkspace?.id ?? null,
        getWorkspaces: () =>
          workspaceRegistry
            ? workspaceRegistry.listSync({ currentWorkspaceId: currentWorkspace?.id })
            : [],
        getWorkspaceStatus,
        getWorkspaceStatusAsync,
        activateWorkspace,
        getWorkspaceManagement,
        getWorkspaceFeatures: (workspaceId) => getWorkspaceManagement(workspaceId)?.getFeatures() ?? null,
        management: createConfigManagementSource({
          getConfigPath: () => daemonPaths?.configPath ?? resolve(configPath),
          getEffectiveMode: () => getExecutionMode(config),
          getRestartState: () =>
            restartScheduled ? { restartState: "scheduled" as const } : { restartState: "idle" as const },
          restart: () =>
            controlPlane?.restart() ?? {
              accepted: false,
              message: "Managed daemon restart is not available",
            },
          onAuditEvent: (event) => {
            controlPlane?.recordEvent({
              level: "info",
              type: `config.${event.type}`,
              message: event.message,
              ...(currentWorkspace?.id ? { workspaceId: currentWorkspace.id } : {}),
              metadata: {
                ...event.metadata,
                ...(currentWorkspace?.id ? { workspaceId: currentWorkspace.id } : {}),
              },
            });
          },
          onMutation: async (mutation, context) => {
            desiredConfig = mutation.config;
            desiredConfigRevision = mutation.configDigest;
            if (currentWorkspaceRegistration && currentWorkspace && workspaceRegistry) {
              currentWorkspaceRegistration = {
                ...currentWorkspaceRegistration,
                configDigest: mutation.configDigest,
              };
              currentWorkspace = {
                ...currentWorkspace,
                configDigest: mutation.configDigest,
                lastSeenAt: new Date().toISOString(),
              };
              await workspaceRegistry.ensure(currentWorkspaceRegistration);
            }
            if (mutation.changed && context.serverId) {
              desiredServerLastChangedAt.set(context.serverId, new Date().toISOString());
            }
          },
        }),
        restart: async () => {
          if (!daemonPaths || !runtimeManifest) {
            return {
              accepted: false,
              message: "Managed daemon restart is not available",
            };
          }
          if (restartScheduled) {
            return {
              accepted: false,
              message: "A daemon restart is already scheduled",
              state: "stopping",
            };
          }

          restartScheduled = true;
          const stopping = transitionReadiness(readinessFromManifest(runtimeManifest), "stopping");
          runtimeManifest = { ...runtimeManifest, ...stopping };
          await writeRuntimeManifest(daemonPaths.runtimeManifest, runtimeManifest).catch((error) => {
            controlPlane?.recordEvent({
              level: "warn",
              type: "daemon.restart.manifest-error",
              message: `Unable to publish restart state: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
          controlPlane?.recordEvent({
            level: "info",
            type: "daemon.restart",
            message: "Daemon restart scheduled",
          });

          const restartTimer = setTimeout(() => {
            try {
              launchManagedRestart(
                daemonPaths as DaemonPaths,
                runtimeManifest as RuntimeManifest,
                verbose,
                (error) => {
                  restartScheduled = false;
                  controlPlane?.recordEvent({
                    level: "error",
                    type: "daemon.restart.error",
                    message: error?.message ?? "Unable to launch the daemon restart process",
                  });
                },
              );
            } catch (error) {
              restartScheduled = false;
              controlPlane?.recordEvent({
                level: "error",
                type: "daemon.restart.error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }, 0);
          unrefTimer(restartTimer);

          return {
            accepted: true,
            message: "Daemon restart scheduled",
            state: "stopping",
          };
        },
      });
      managementCredentials = new ManagementCredentialStore({
        workspaceId: currentWorkspace?.id,
        authority: "host",
        // A console handoff may be requested from a second directory that has
        // already registered with this host. The registry is the authority for
        // those claims; credentials never mint arbitrary path-derived IDs.
        canIssueWorkspace: (workspaceId) =>
          workspaceRegistry ? workspaceRegistry.getSync(workspaceId) !== null : false,
      });
    }

    const isManagedHost = Boolean(
      isDaemon &&
        daemonPaths?.runtimeManifest &&
        workspaceRegistry &&
        workspaceLeaseTracker &&
        currentWorkspaceRegistration &&
        currentWorkspace,
    );

    if (isManagedHost) {
      const registry = workspaceRegistry as WorkspaceRegistry;
      const leaseTracker = workspaceLeaseTracker as WorkspaceLeaseTracker;
      const primaryRegistration = currentWorkspaceRegistration as WorkspaceRegistrationInput;

      workspaceRuntimeManager = new WorkspaceRuntimeManager({
        gatewayOptions: {
          verbose,
          clearOpenApiCache: clearCache,
        },
      });

      const resolveRuntimeInput = async (
        context?: HttpRequestContext,
      ): Promise<WorkspaceRuntimeInput> => {
        const registeredWorkspaceIds = registry.listSync().map((workspace) => workspace.id);
        const workspaceId =
          context?.workspaceId ??
          (registeredWorkspaceIds.length <= 1 ? currentWorkspace?.id : undefined);
        if (!workspaceId) {
          throw new Error(
            "MCP request must include a bridge lease when multiple workspaces are registered",
          );
        }

        const workspace = registry.getSync(workspaceId);
        if (!workspace) {
          throw new Error("MCP request workspace is not registered with this daemon");
        }

        const workspaceConfig = await loadConfig(workspace.configPath, { env: process.env });
        const configDigest = await fingerprintConfigFile(workspace.configPath).catch(
          () => workspace.configDigest,
        );
        return {
          directory: workspace.directory,
          configPath: workspace.configPath,
          config: workspaceConfig,
          configDigest,
          cwd: workspace.directory,
          env: process.env,
        };
      };

      const dispatchMcp = async (
        message: import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage,
        sessionId: string,
        context?: HttpRequestContext,
      ) => {
        const input = await resolveRuntimeInput(context);
        return workspaceRuntimeManager!.withRuntime(input, (runtime) =>
          runtime.gateway.handleRequestWithSession(message, sessionId),
        );
      };

      const httpOptions = {
        authToken: runtimeManifest?.localAuthToken,
        health: () => ({
          instanceId: runtimeManifest?.instanceId,
          profileId: runtimeManifest?.profileId,
          pid: runtimeManifest?.pid,
          state: runtimeManifest?.state,
          cliVersion: runtimeManifest?.cliVersion,
          protocolVersion: runtimeManifest?.protocolVersion,
          hostProtocolVersion: DAEMON_HOST_MANIFEST_PROTOCOL_VERSION,
          hostCapabilityVersion: DAEMON_HOST_CAPABILITY_VERSION,
          hostCapabilities: DAEMON_HOST_CAPABILITIES,
          configFingerprint: runtimeManifest?.configFingerprint,
          host: runtimeManifest?.host,
          port: runtimeManifest?.port,
          readyAt: runtimeManifest?.readyAt,
        }),
        controlPlane: controlPlane ?? undefined,
        managementCredentials: managementCredentials ?? undefined,
        connectionTracker: leaseTracker,
        dispatchMcp,
        onSessionInitialize: (
          sessionId: string,
          _clientInfo: { name: string; version?: string } | undefined,
          context?: HttpRequestContext,
        ) => {
          const workspaceId = context?.workspaceId ?? currentWorkspace?.id;
          if (workspaceId) sessionWorkspaceIds.set(sessionId, workspaceId);
        },
        onSessionClose: (sessionId: string) => {
          sessionWorkspaceIds.delete(sessionId);
        },
      };

      // The first runtime is initialized before the host advertises readiness,
      // while subsequent workspaces are created lazily on their first request.
      const primaryRuntime = await workspaceRuntimeManager.getOrCreate({
        ...primaryRegistration,
        config,
        cwd: primaryRegistration.directory,
        env: process.env,
      });
      gateway = primaryRuntime.gateway;
      hostHttpServer = createHttpServerTransport(
        httpPort as number,
        runtimeManifest?.host ?? options.host ?? config.httpServer?.host ?? "127.0.0.1",
        httpOptions,
      );
    } else {
      gateway = createGateway({
        config,
        mode,
        httpPort,
        httpHost: isDaemon
          ? runtimeManifest?.host ?? options.host ?? config.httpServer?.host ?? "127.0.0.1"
          : options.host,
        httpOptions:
          runtimeManifest === null
            ? undefined
            : {
                authToken: runtimeManifest.localAuthToken,
                health: () => ({
                  instanceId: runtimeManifest?.instanceId,
                  profileId: runtimeManifest?.profileId,
                  pid: runtimeManifest?.pid,
                  state: runtimeManifest?.state,
                  cliVersion: runtimeManifest?.cliVersion,
                  protocolVersion: runtimeManifest?.protocolVersion,
                  hostProtocolVersion: DAEMON_HOST_MANIFEST_PROTOCOL_VERSION,
                  hostCapabilityVersion: DAEMON_HOST_CAPABILITY_VERSION,
                  hostCapabilities: DAEMON_HOST_CAPABILITIES,
                  configFingerprint: runtimeManifest?.configFingerprint,
                  host: runtimeManifest?.host,
                  port: runtimeManifest?.port,
                  readyAt: runtimeManifest?.readyAt,
                }),
                controlPlane: controlPlane ?? undefined,
                managementCredentials: managementCredentials ?? undefined,
                connectionTracker: workspaceLeaseTracker ?? undefined,
                onSessionInitialize: (
                  sessionId: string,
                  _clientInfo: { name: string; version?: string } | undefined,
                  context?: HttpRequestContext,
                ) => {
                  if (context?.workspaceId) {
                    sessionWorkspaceIds.set(sessionId, context.workspaceId);
                  }
                },
                onSessionClose: (sessionId: string) => {
                  sessionWorkspaceIds.delete(sessionId);
                },
              },
        verbose,
        clearOpenApiCache: clearCache,
      });
    }

    setupSignalHandlers(
      gateway,
      daemonPaths,
      () => runtimeManifest,
      () => controlPlane,
      () => workspaceLeaseTracker,
      () => hostHttpServer,
      () => workspaceRuntimeManager,
    );

    if (!isManagedHost) {
      await gateway.start();
    } else {
      await hostHttpServer?.start();
    }

    if (isDaemon && daemonPaths && runtimeManifest) {
      const actualPort = hostHttpServer?.getPort() ?? gateway.getHttpPort() ?? httpPort;
      if (!actualPort) {
        throw new Error("Daemon HTTP transport did not report a bound port");
      }

      const ready = transitionReadiness(
        readinessFromManifest(runtimeManifest),
        "ready",
      );
      runtimeManifest = {
        ...runtimeManifest,
        ...ready,
        port: actualPort,
        mcpUrl: `http://${formatHost(runtimeManifest.host)}:${actualPort}/mcp`,
        controlUrl: `http://${formatHost(runtimeManifest.host)}:${actualPort}`,
      };
      await writeRuntimeManifest(daemonPaths.runtimeManifest, runtimeManifest);
      if (verbose) {
        console.error(`[daemon] Runtime manifest published as ready on port ${actualPort}`);
      }

      controlPlane?.recordEvent({
        level: "info",
        type: "daemon.ready",
        message: `Daemon ready on port ${actualPort}`,
        metadata: { port: actualPort },
      });

      if (startupLock) {
        await startupLock.release();
        startupLock = null;
      }
    } else if (isDaemon && daemonPaths) {
      // Compatibility path for callers with a pre-contract DaemonPaths
      // object. Production paths use the manifest's actual bound port.
      writeFileSync(daemonPaths.port, String(httpPort));
    }

    if (mode === "stdio") {
      await new Promise(() => {});
    }
  } catch (err) {
    if (startupLock) {
      await startupLock.release().catch(() => undefined);
      startupLock = null;
    }
    if (workspaceRuntimeManager) {
      await workspaceRuntimeManager.disposeAll().catch(() => undefined);
    } else if (gateway) {
      await gateway.stop().catch(() => undefined);
    }
    if (hostHttpServer) await hostHttpServer.stop().catch(() => undefined);
    await workspaceLeaseTracker?.destroy();
    if (runtimeManifest && daemonPaths?.runtimeManifest) {
      await removeRuntimeManifestIfCurrent(daemonPaths, runtimeManifest);
      runtimeManifest = null;
    }

    // Handle missing config file with interactive prompt
    if (err instanceof ConfigError && err.message.includes("No config file found")) {
      console.error(`Error: ${err.message}`);

      // Only offer interactive prompt if running in a TTY
      if (process.stdin.isTTY) {
        const shouldCreate = await p.confirm({
          message: "Would you like to create a config file now?",
        });

        if (!p.isCancel(shouldCreate) && shouldCreate) {
          await configCommand();

          // Show MCP client configuration instructions
          p.log.info("You can configure your MCP client as follows:");
          console.log(`
{
  "mcpServers": {
    "routermcp": {
      "command": "bunx",
      "args": [
        "-y",
        "routermcp"
      ]
    }
  }
}
`);
          return;
        }
      }

      process.exit(1);
    }

    if (err instanceof RouterMcpError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function createControlPlaneStatus(
  manifest: RuntimeManifest | null,
  gateway: Gateway | null,
  paths: DaemonPaths | null,
  requestedPort: number | undefined,
  workspace: WorkspaceSnapshot | null = null,
  desiredConfigDigest?: string,
  restartPending = false,
): ControlPlaneStatus {
  const host = manifest?.host ?? "127.0.0.1";
  const port = manifest?.port ?? gateway?.getHttpPort() ?? requestedPort ?? 0;
  const fallbackBaseUrl = port > 0 ? `http://${formatHost(host)}:${port}` : "";
  const startedAt = manifest?.startedAt ?? new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const uptimeSeconds = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.round(((Date.now() - startedAtMs) / 1_000) * 100) / 100)
    : 0;

  let state: ControlPlaneStatus["state"] = manifest?.state ?? "offline";
  if (
    state === "ready" &&
    (gateway?.getUpstreamServers().some((server) => server.status === "error" || server.error) ||
      gateway?.getOpenApiServerSnapshots().some((server) => server.status === "error"))
  ) {
    state = "degraded";
  } else if (!manifest) {
    state = gatewayStateToControlState(gateway?.getState());
  }

  return {
    state,
    instanceId: manifest?.instanceId ?? "unknown",
    ...(manifest?.pid ? { pid: manifest.pid } : {}),
    version: manifest?.cliVersion ?? "unknown",
    protocolVersion: manifest?.protocolVersion ?? "unknown",
    profile: manifest?.profileId ?? paths?.profileId ?? "unknown",
    configDigest: desiredConfigDigest ?? manifest?.configFingerprint ?? "unknown",
    host,
    port,
    mcpUrl: manifest?.mcpUrl ?? (fallbackBaseUrl ? `${fallbackBaseUrl}/mcp` : ""),
    controlUrl: manifest?.controlUrl ?? fallbackBaseUrl,
    startedAt,
    uptimeSeconds,
    ...(workspace
      ? {
          workspaceId: workspace.id,
          workspaceDirectory: workspace.directory,
          workspaceConfigPath: workspace.configPath,
        }
      : {}),
    ...(restartPending
      ? { pendingRestart: true, restartState: "scheduled" as const }
      : { pendingRestart: false, restartState: "idle" as const }),
  };
}

function createControlPlaneServers(
  gateway: Gateway | null,
  desiredConfig: RouterMcpConfig | null,
  configRevision: string | undefined,
  lastChangedAtByServer: ReadonlyMap<string, string>,
): ControlPlaneServer[] {
  const observedMcp = new Map(
    (gateway?.getUpstreamServers() ?? []).map((server) => [server.name, server]),
  );
  const mcpNames = new Set([
    ...Object.keys(desiredConfig?.mcpServers ?? {}),
    ...observedMcp.keys(),
  ]);

  const mcpServers = Array.from(mcpNames, (name) => {
    const desired = desiredConfig?.mcpServers[name];
    const observed = observedMcp.get(name);
    const configured = desired ?? observed?.config;
    const enabled = configured?.enabled !== false;
    const observedState = observed
      ? upstreamStateToControlState(observed)
      : enabled
        ? "unknown"
        : "offline";
    const url = sanitizeUrl(configured?.url);
    const lastError = observed?.error ? sanitizeText(observed.error.message) : undefined;
    const serverId = `mcp:${sanitizeText(name)}`;

    return {
      id: serverId,
      name: sanitizeText(name),
      kind: "mcp",
      ...(url ? { url } : {}),
      ...(configured?.transport ? { transport: configured.transport } : {}),
      enabled,
      observedState,
      ...(configRevision ? { configRevision } : {}),
      ...(lastChangedAtByServer.get(serverId)
        ? { lastChangedAt: lastChangedAtByServer.get(serverId) }
        : {}),
      // `state` is retained as the backwards-compatible alias for clients
      // that predate the explicit desired/observed fields.
      state: observedState,
      toolCount: observed
        ? Math.max(0, observed.cachedTools.length || observed.tools.length)
        : 0,
      ...(observed?.lastLatencyMs !== undefined && observed.lastLatencyMs !== null
        ? { latencyMs: Math.max(0, Math.round(observed.lastLatencyMs)) }
        : {}),
      ...(observed?.lastCheckedAt !== undefined && observed.lastCheckedAt !== null
        ? { lastCheckedAt: new Date(observed.lastCheckedAt).toISOString() }
        : {}),
      ...(lastError ? { lastError } : {}),
    } satisfies ControlPlaneServer;
  });

  const observedOpenApi = new Map(
    (gateway?.getOpenApiServerSnapshots() ?? []).map((server) => [server.name, server]),
  );
  const openApiNames = new Set([
    ...Object.keys(desiredConfig?.openApiServers ?? {}),
    ...observedOpenApi.keys(),
  ]);

  const openApiServers = Array.from(openApiNames, (name) => {
    const desired = desiredConfig?.openApiServers?.[name];
    const observed = observedOpenApi.get(name);
    const enabled = desired?.enabled !== false;
    const observedState = observed
      ? openApiStateToControlState(observed)
      : enabled
        ? "unknown"
        : "offline";
    const url = sanitizeUrl(desired?.baseUrl ?? observed?.baseUrl);
    const serverId = `openapi:${sanitizeText(name)}`;

    return {
      id: serverId,
      name: sanitizeText(name),
      kind: "openapi",
      ...(url ? { url } : {}),
      transport: "openapi",
      enabled,
      observedState,
      ...(configRevision ? { configRevision } : {}),
      ...(lastChangedAtByServer.get(serverId)
        ? { lastChangedAt: lastChangedAtByServer.get(serverId) }
        : {}),
      state: observedState,
      toolCount: observed ? Math.max(0, Math.floor(observed.toolCount)) : 0,
      ...(observed?.lastLatencyMs !== undefined
        ? { latencyMs: Math.max(0, Math.round(observed.lastLatencyMs)) }
        : {}),
      ...(observed?.lastCheckedAt !== undefined
        ? { lastCheckedAt: new Date(observed.lastCheckedAt).toISOString() }
        : {}),
      ...(observed?.lastError ? { lastError: sanitizeText(observed.lastError) } : {}),
    } satisfies ControlPlaneServer;
  });

  return [...mcpServers, ...openApiServers];
}

function openApiStateToControlState(
  server: ReturnType<Gateway["getOpenApiServerSnapshots"]>[number],
): ControlPlaneServer["state"] {
  switch (server.status) {
    case "pending":
    case "loading":
      return "starting";
    case "ready":
      return "online";
    case "error":
      return server.toolCount > 0 ? "degraded" : "offline";
  }
}

function createControlPlaneSessions(
  gateway: Gateway | null,
  manifest: RuntimeManifest | null,
  sessionWorkspaceIds: Map<string, string> = new Map(),
  profileOverride?: string,
): ControlPlaneSession[] {
  if (!gateway) return [];

  const profile = profileOverride ?? manifest?.profileId;
  const sessionSnapshots = gateway.getSessionSnapshots();
  const liveSessionIds = new Set(sessionSnapshots.map((session) => session.id));
  for (const sessionId of sessionWorkspaceIds.keys()) {
    if (!liveSessionIds.has(sessionId)) sessionWorkspaceIds.delete(sessionId);
  }

  const sessions: ControlPlaneSession[] = sessionSnapshots.map((session) => {
    const workspaceId = sessionWorkspaceIds.get(session.id);
    return {
      id: `mcp:${session.id}`,
      kind: "mcp",
      clientName: session.clientName ?? "MCP client",
      ...(session.clientVersion ? { clientVersion: session.clientVersion } : {}),
      ...(profile ? { profile } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      state: session.state,
      connectedAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    };
  });

  const now = Date.now();
  for (const lease of gateway.getConnectionLeases()) {
    sessions.push({
      id: `bridge:${lease.leaseId}`,
      kind: "bridge",
      clientName: "stdio bridge",
      ...(lease.profileId ?? profile
        ? { profile: lease.profileId ?? profile }
        : {}),
      ...(lease.workspaceId ? { workspaceId: lease.workspaceId } : {}),
      state: Date.parse(lease.leaseExpiresAt) > now ? "active" : "expired",
      connectedAt: lease.connectedAt,
      lastSeenAt: lease.lastSeenAt,
      leaseExpiresAt: lease.leaseExpiresAt,
    });
  }

  return sessions.sort((left, right) => {
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}

function upstreamStateToControlState(
  server: UpstreamServer,
): ControlPlaneServer["state"] {
  switch (server.status) {
    case "connected":
    case "discovered":
      return "online";
    case "connecting":
      return "starting";
    case "error":
      return hasCachedCapabilities(server) ? "degraded" : "offline";
    case "disabled":
    case "disconnected":
      return "offline";
  }
}

function hasCachedCapabilities(server: UpstreamServer): boolean {
  return (
    server.cachedTools.length > 0 ||
    server.cachedResources.length > 0 ||
    server.cachedPrompts.length > 0
  );
}

function gatewayStateToControlState(
  state: ReturnType<Gateway["getState"]> | undefined,
): ControlPlaneStatus["state"] {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
      return "ready";
    case "stopping":
      return "stopping";
    case "error":
      return "failed";
    default:
      return "offline";
  }
}

function emptyControlPlaneMetrics() {
  return {
    requestsTotal: 0,
    requestsPerSecond: 0,
    errorsTotal: 0,
    errorRate: 0,
    toolCallsTotal: 0,
    activeSessions: 0,
    activeLeases: 0,
    latencyMs: { p50: 0, p95: 0, p99: 0 },
  };
}

export interface ManagedRestartInvocation {
  command: string;
  args: string[];
}

export function buildManagedRestartInvocation(
  script: string,
  paths: Pick<DaemonPaths, "projectPath">,
  manifest: Pick<RuntimeManifest, "configPath" | "host" | "port">,
  verbose: boolean,
): ManagedRestartInvocation {
  const args = [
    "restart",
    "--config",
    manifest.configPath,
    "--project",
    paths.projectPath,
    "--host",
    manifest.host,
  ];
  if (manifest.port) args.push("--port", String(manifest.port));
  if (verbose) args.push("--verbose");
  return buildRuntimeInvocation(script, args);
}

function launchManagedRestart(
  paths: DaemonPaths,
  manifest: RuntimeManifest,
  verbose: boolean,
  onError: (error?: Error) => void,
): void {
  const script = process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (!script) throw new Error("Unable to determine the RouterMCP CLI entrypoint for restart");

  const invocation = buildManagedRestartInvocation(script, paths, manifest, verbose);

  const env = { ...process.env };
  delete env.ROUTERMCP_DAEMON;
  delete env.ROUTERMCP_DAEMON_LOCK_HELD;
  if (manifest.localAuthToken) {
    env[MANAGED_RESTART_AUTH_TOKEN_ENV] = manifest.localAuthToken;
  } else {
    delete env[MANAGED_RESTART_AUTH_TOKEN_ENV];
  }

  const child = spawn(invocation.command, invocation.args, {
    cwd: paths.projectPath,
    detached: true,
    stdio: "ignore",
    env,
  });
  let finished = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: Error): void => {
    if (finished) return;
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    if (error) onError(error);
  };

  child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  child.once("exit", (code, signal) => {
    if (code === 0) {
      finish();
      return;
    }
    finish(
      new Error(
        `Managed daemon restart exited unsuccessfully${code === null ? ` from ${signal ?? "a signal"}` : ` with code ${code}`}`,
      ),
    );
  });
  watchdog = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited between the watchdog firing and signal delivery.
    }
    finish(new Error(`Managed daemon restart did not complete within ${MANAGED_RESTART_TIMEOUT_MS}ms`));
  }, MANAGED_RESTART_TIMEOUT_MS);
  unrefTimer(watchdog);
  child.unref();
}

function readManagedRestartAuthToken(): string | undefined {
  const value = process.env[MANAGED_RESTART_AUTH_TOKEN_ENV];
  // Consume the handoff so a daemon process cannot accidentally pass this
  // private credential to a later child. Invalid external values never
  // override a freshly generated token.
  delete process.env[MANAGED_RESTART_AUTH_TOKEN_ENV];
  return value && LOCAL_AUTH_TOKEN_PATTERN.test(value) ? value : undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as unknown as { unref?: () => void };
  maybeTimer.unref?.();
}

function setupSignalHandlers(
  gateway: Gateway,
  daemonPaths: DaemonPaths | null,
  getRuntimeManifest: () => RuntimeManifest | null,
  getControlPlane: () => ControlPlane | null,
  getWorkspaceLeaseTracker: () => WorkspaceLeaseTracker | null,
  getHostHttpServer: () => HttpServerHandle | null = () => null,
  getWorkspaceRuntimeManager: () => WorkspaceRuntimeManager | null = () => null,
): void {
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.error(`\nReceived ${signal}, shutting down...`);
    try {
      const manifest = getRuntimeManifest();
      if (manifest && daemonPaths?.runtimeManifest) {
        await markManifestStopping(daemonPaths, manifest);
      }
      if (manifest) {
        getControlPlane()?.recordEvent({
          level: "info",
          type: "daemon.stopping",
          message: `Daemon stopping after ${signal}`,
        });
      }
      const runtimeManager = getWorkspaceRuntimeManager();
      if (runtimeManager) {
        await runtimeManager.disposeAll();
      } else {
        await gateway.stop();
      }
      await getHostHttpServer()?.stop();
      await getWorkspaceLeaseTracker()?.destroy();
      if (manifest && daemonPaths?.runtimeManifest) {
        await removeRuntimeManifestIfCurrent(daemonPaths, manifest);
      }
      cleanupLegacyDaemonFiles(daemonPaths);
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      cleanupLegacyDaemonFiles(daemonPaths);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function cleanupLegacyDaemonFiles(paths: DaemonPaths | null): void {
  if (!paths) return;

  for (const file of [paths.pid, paths.port, paths.socket]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors after the process has stopped.
    }
  }
}

function readinessFromManifest(manifest: RuntimeManifest): ReturnType<typeof createReadinessSnapshot> {
  return {
    state: manifest.state,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    ...(manifest.readyAt ? { readyAt: manifest.readyAt } : {}),
    ...(manifest.failedAt ? { failedAt: manifest.failedAt } : {}),
    ...(manifest.stoppingAt ? { stoppingAt: manifest.stoppingAt } : {}),
    ...(manifest.error ? { error: manifest.error } : {}),
  };
}

async function markManifestStopping(paths: DaemonPaths, manifest: RuntimeManifest): Promise<void> {
  const current = await readRuntimeManifest(paths.runtimeManifest);
  if (!current || current.instanceId !== manifest.instanceId) return;
  if (!(await matchesProcessIdentity(current.processIdentity))) return;

  const stopping =
    current.state === "stopping"
      ? readinessFromManifest(current)
      : transitionReadiness(readinessFromManifest(current), "stopping");
  await writeRuntimeManifest(paths.runtimeManifest, { ...current, ...stopping });
}

async function removeRuntimeManifestIfCurrent(
  paths: DaemonPaths,
  manifest: RuntimeManifest,
): Promise<void> {
  const current = await readRuntimeManifest(paths.runtimeManifest);
  if (current?.instanceId === manifest.instanceId) {
    await removeRuntimeManifest(paths.runtimeManifest);
  }
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
