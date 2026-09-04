export const DAEMON_READINESS_STATES = ["starting", "ready", "failed", "stopping"] as const;

export type DaemonReadinessState = (typeof DAEMON_READINESS_STATES)[number];

export interface ReadinessError {
  code?: string;
  message: string;
}

export interface ReadinessSnapshot {
  state: DaemonReadinessState;
  startedAt: string;
  updatedAt: string;
  readyAt?: string;
  failedAt?: string;
  stoppingAt?: string;
  error?: ReadinessError;
}

/** Runtime states accepted by the manifest contract. */
export function isReadinessState(value: unknown): value is DaemonReadinessState {
  return (
    typeof value === "string" &&
    (DAEMON_READINESS_STATES as readonly string[]).includes(value)
  );
}

/**
 * Return whether a state transition is valid for one daemon instance.
 * Repeating a state is allowed because the manifest is also used to publish
 * port/readiness metadata incrementally.
 */
export function canTransitionReadiness(
  from: DaemonReadinessState,
  to: DaemonReadinessState,
): boolean {
  if (from === to) {
    return true;
  }

  switch (from) {
    case "starting":
      return to === "ready" || to === "failed" || to === "stopping";
    case "ready":
      return to === "failed" || to === "stopping";
    case "failed":
      return to === "starting" || to === "stopping";
    case "stopping":
      return false;
  }
}

/**
 * Build an initial readiness snapshot. A caller can serialize this snapshot
 * into a starting runtime manifest before binding its listener.
 */
export function createReadinessSnapshot(
  state: DaemonReadinessState = "starting",
  now: Date = new Date(),
): ReadinessSnapshot {
  const timestamp = now.toISOString();
  const snapshot: ReadinessSnapshot = {
    state,
    startedAt: timestamp,
    updatedAt: timestamp,
  };

  if (state === "ready") {
    snapshot.readyAt = timestamp;
  } else if (state === "failed") {
    snapshot.failedAt = timestamp;
  } else if (state === "stopping") {
    snapshot.stoppingAt = timestamp;
  }

  return snapshot;
}

/**
 * Advance a snapshot while preserving its original startup timestamp.
 */
export function transitionReadiness(
  current: ReadinessSnapshot,
  state: DaemonReadinessState,
  options: { error?: ReadinessError; now?: Date } = {},
): ReadinessSnapshot {
  if (!canTransitionReadiness(current.state, state)) {
    throw new Error(`Invalid daemon readiness transition: ${current.state} -> ${state}`);
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const next: ReadinessSnapshot = {
    ...current,
    state,
    updatedAt: timestamp,
  };

  if (state === "ready" && !next.readyAt) {
    next.readyAt = timestamp;
  }

  if (state === "failed") {
    next.failedAt = timestamp;
    next.error = options.error;
  } else if (state === "stopping") {
    next.stoppingAt = timestamp;
    delete next.error;
  } else {
    delete next.error;
  }

  return next;
}
