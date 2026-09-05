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

export interface ControlPlaneMutationResult {
  accepted: boolean;
  changed: boolean;
  mutationId: string;
  configDigest: string;
  previousConfigDigest: string;
  restartState: ManagementRestartState;
  restart?: ControlPlaneManagementRestartResult;
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
  /** Sanitized audit sink; it must not receive config contents or secrets. */
  onAuditEvent?: (event: {
    type: "server.enabled" | "features.mode";
    message: string;
    metadata: Record<string, string | number | boolean | null>;
  }) => void;
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
    message: string;
    metadata: Record<string, string | number | boolean | null>;
  },
): Promise<ControlPlaneMutationResult> {
  let restart: ControlPlaneManagementRestartResult | undefined;
  let restartState: ManagementRestartState = "idle";

  if (mutation.changed) {
    try {
      restart = options.restart
        ? await options.restart()
        : {
            accepted: false,
            message: "Controlled context restart is not configured",
          };
      restartState = restart.accepted ? "scheduled" : "failed";
    } catch {
      restart = {
        accepted: false,
        message: "Configuration changed, but context restart could not be scheduled",
      };
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
  };
}
