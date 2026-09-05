/** Shared route prefixes for the control-plane and its future extensions. */
export const CONTROL_PLANE_PATH = "/api/v1" as const;
export const CONTROL_PLANE_HEALTH_PATH = `${CONTROL_PLANE_PATH}/health` as const;
