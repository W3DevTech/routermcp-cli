import {
  createExecutionModeSnapshot,
  readConfigSnapshot,
  setExecutionMode,
  setServerEnabled,
  type ConfigMutationResult,
  type ControlPlaneExecutionMode,
  type ExecutionModePatch,
  type ServerEnabledPatch,
} from "../config/mutation.js";

export type { ServerEnabledPatch } from "../config/mutation.js";

export type ManagementRestartState = "idle" | "scheduled" | "restarting" | "failed";

export interface ControlPlaneFeatures {
  /** Desired mode read from the selected config source. */
  mode: ControlPlaneExecutionMode;
  /** Mode currently exposed by the live gateway context. */
  effectiveMode: ControlPlaneExecutionMode;
  codeMode: {
    timeout: number;
    allowFetch: boolean;
  };
  configDigest: string;
  restartState: ManagementRestartState;
  restartId?: string;
  restartMessage?: string;
}

export interface ControlPlaneManagementRestartResult {
  accepted: boolean;
  message: string;
  state?: "starting" | "ready" | "degraded" | "failed" | "stopping" | "offline";
  restartId?: string;
}

/**
 * Result of reconciling one workspace after a persisted configuration edit.
 * The callback is context-bound and must not replace the daemon host process
 * or its listener. `restartId` is retained as a wire-compatible identifier
 * until hosted clients migrate to `reloadId`.
 */
export interface ControlPlaneManagementReloadResult {
  accepted: boolean;
  message: string;
  state?: "starting" | "ready" | "degraded" | "failed" | "stopping" | "offline";
  reloadId?: string;
}

export interface ControlPlaneMutationResult {
  accepted: boolean;
  changed: boolean;
  mutationId: string;
  configDigest: string;
  previousConfigDigest: string;
  restartState: ManagementRestartState;
  restart?: ControlPlaneManagementRestartResult;
  reload?: ControlPlaneManagementReloadResult;
}

export interface ControlPlaneManagementSource {
  getFeatures: () => ControlPlaneFeatures | Promise<ControlPlaneFeatures>;
  updateServer: (
    serverId: string,
    patch: ServerEnabledPatch,
    expectedDigest: string,
  ) => ControlPlaneMutationResult | Promise<ControlPlaneMutationResult>;
  updateFeatures: (
    patch: ExecutionModePatch,
    expectedDigest: string,
  ) => ControlPlaneMutationResult | Promise<ControlPlaneMutationResult>;
}

/** Context for a mutation notification consumed by an in-process daemon host. */
export interface ConfigManagementMutationContext {
  type: "server.enabled" | "features.mode";
  /** Prefixed server ID when the mutation changed server availability. */
  serverId?: string;
}

export interface ConfigManagementSourceOptions {
  /** Return the exact resolved config path for the selected workspace. */
  getConfigPath: () => string | Promise<string>;
  /** Return live mode from the selected gateway/context, if it differs from disk. */
  getEffectiveMode?: () => ControlPlaneExecutionMode | Promise<ControlPlaneExecutionMode>;
  /** Return an in-flight restart state maintained by the workspace host. */
  getRestartState?: () =>
    | Pick<ControlPlaneFeatures, "restartState" | "restartId" | "restartMessage">
    | Promise<Pick<ControlPlaneFeatures, "restartState" | "restartId" | "restartMessage">>;
  /** Controlled context restart/rebuild callback. */
  restart?: () =>
    | ControlPlaneManagementRestartResult
    | Promise<ControlPlaneManagementRestartResult>;
  /**
   * Controlled reload/reconciliation callback for one isolated workspace.
   * Implementations must retain the host PID/listener and reconcile only the
   * context bound to this source. Prefer this callback for multi-workspace
   * daemon hosts; `restart` remains for legacy single-profile daemons.
   */
  reload?: () =>
    | ControlPlaneManagementReloadResult
    | Promise<ControlPlaneManagementReloadResult>;
  /** Sanitized audit sink; it must not receive config contents or secrets. */
  onAuditEvent?: (event: {
    type: "server.enabled" | "features.mode";
    message: string;
    metadata: Record<string, string | number | boolean | null>;
  }) => void;
  /**
   * Notify the running host about the parsed post-mutation config. The
   * callback is separate from the audit sink so desired state can be refreshed
   * while the live gateway still reports observed state during a restart.
   */
  onMutation?: (
    mutation: ConfigMutationResult,
    context: ConfigManagementMutationContext,
  ) => void | Promise<void>;
}

/**
 * Build a context-scoped management adapter from config and daemon hooks.
 *
 * The adapter deliberately accepts functions instead of a singleton config
 * path. A workspace host can therefore bind one instance per context and
 * route management requests without merging credentials or capability maps.
 */
export function createConfigManagementSource(
  options: ConfigManagementSourceOptions,
): ControlPlaneManagementSource {
  return {
    getFeatures: async () => {
      const configPath = await options.getConfigPath();
      const snapshot = await readConfigSnapshot(configPath);
      const restart = await options.getRestartState?.();
      return {
        ...createExecutionModeSnapshot(snapshot),
        effectiveMode: options.getEffectiveMode
          ? await options.getEffectiveMode()
          : createExecutionModeSnapshot(snapshot).mode,
        ...(restart ?? { restartState: "idle" }),
      };
    },

    updateServer: async (serverId, patch, expectedDigest) => {
      const configPath = await options.getConfigPath();
      const mutation = await setServerEnabled({
        configPath,
        expectedDigest,
        serverId,
        enabled: patch.enabled,
      });
      return finishMutation(mutation, options, {
        type: "server.enabled",
        serverId,
        message: "Server availability updated",
        metadata: {
          serverId,
          enabled: patch.enabled,
          ...(mutation.previousEnabled === undefined
            ? {}
            : { previousEnabled: mutation.previousEnabled }),
        },
      });
    },

    updateFeatures: async (patch, expectedDigest) => {
      const configPath = await options.getConfigPath();
      const mutation = await setExecutionMode({ configPath, expectedDigest, patch });
      return finishMutation(mutation, options, {
        type: "features.mode",
        message: "Execution mode updated",
        metadata: {
          mode: patch.mode,
          ...(mutation.previousMode === undefined
            ? {}
            : { previousMode: mutation.previousMode }),
        },
      });
    },
  };
}

async function finishMutation(
  mutation: ConfigMutationResult,
  options: ConfigManagementSourceOptions,
  audit: {
    type: "server.enabled" | "features.mode";
    serverId?: string;
    message: string;
    metadata: Record<string, string | number | boolean | null>;
  },
): Promise<ControlPlaneMutationResult> {
  let restart: ControlPlaneManagementRestartResult | undefined;
  let reload: ControlPlaneManagementReloadResult | undefined;
  let restartState: ManagementRestartState = "idle";

  // The mutation result contains the validated config read from disk after
  // the JSONC edit. Publish it before scheduling a restart so management
  // snapshots expose new desired state immediately while the old gateway
  // continues to supply live observed state during a restart.
  try {
    await options.onMutation?.(mutation, {
      type: audit.type,
      ...(audit.serverId ? { serverId: audit.serverId } : {}),
    });
  } catch {
    // A snapshot refresh is best effort and must not turn a persisted config
    // mutation into a failed request.
    console.error("[management] Desired-state refresh failed after config mutation");
  }

  if (mutation.changed) {
    try {
      if (options.reload) {
        reload = await options.reload();
        restartState = reload.accepted ? "scheduled" : "failed";
      } else {
        restart = options.restart
          ? await options.restart()
          : {
              accepted: false,
              message: "Controlled context restart is not configured",
            };
        restartState = restart.accepted ? "scheduled" : "failed";
      }
    } catch {
      if (options.reload) {
        reload = {
          accepted: false,
          message: "Configuration changed, but context reload could not be scheduled",
        };
      } else {
        restart = {
          accepted: false,
          message: "Configuration changed, but context restart could not be scheduled",
        };
      }
      restartState = "failed";
    }
  }

  try {
    options.onAuditEvent?.({
      ...audit,
      metadata: {
        ...audit.metadata,
        changed: mutation.changed,
        mutationId: mutation.mutationId,
        configRevision: mutation.configDigest,
        restartState,
      },
    });
  } catch {
    // A diagnostic sink must not turn a successfully persisted config change
    // into an HTTP failure or cause the UI to retry a mutation.
    console.error("[management] Audit event sink failed after config mutation");
  }

  return {
    accepted: true,
    changed: mutation.changed,
    mutationId: mutation.mutationId,
    configDigest: mutation.configDigest,
    previousConfigDigest: mutation.previousConfigDigest,
    restartState,
    ...(restart ? { restart } : {}),
    ...(reload ? { reload } : {}),
  };
}
