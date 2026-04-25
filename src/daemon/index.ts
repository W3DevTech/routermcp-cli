export { ConnectionTracker } from "./connection-tracker.js";
export {
  cleanupDaemonFiles,
  connectToSocket,
  type DaemonStatus,
  getDaemonStatus,
  isProcessRunning,
  startDaemon,
  stopDaemon,
} from "./lifecycle.js";
export { type DaemonPaths, getDaemonPaths, isWindows } from "./paths.js";
export {
  getDaemonDir,
  getProjectId,
  getProjectsDir,
  getRouterMcpDir,
  getUserGlobalConfigPath,
  getUserProjectConfigPath,
} from "./project.js";
