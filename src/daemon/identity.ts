import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessIdentitySource = "procfs" | "ps" | "pid";

/**
 * An identity for a process that remains stable for the lifetime of a PID.
 *
 * `startToken` is available on Linux and macOS. Windows currently falls back
 * to a PID liveness check; the platform-hardening phase can replace that
 * fallback with a native creation-time query without changing this contract.
 */
export interface ProcessIdentity {
  pid: number;
  source: ProcessIdentitySource;
  startToken?: string;
}

/**
 * Check whether a PID currently exists.
 *
 * EPERM means the process exists but cannot be signalled by this user, so it
 * is treated as alive. Invalid PIDs and ESRCH are treated as not running.
 */
export function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Capture a process identity suitable for storing in the runtime manifest or
 * lock owner record. Returns null if the process no longer exists or its
 * platform-specific identity cannot be read.
 */
export async function getProcessIdentity(pid: number = process.pid): Promise<ProcessIdentity | null> {
  if (!isProcessRunning(pid)) {
    return null;
  }

  if (process.platform === "linux") {
    const identity = await getLinuxProcessIdentity(pid);
    if (identity) {
      return identity;
    }
  }

  if (process.platform === "darwin" || process.platform === "freebsd") {
    const identity = await getPsProcessIdentity(pid);
    if (identity) {
      return identity;
    }
  }

  // A PID-only identity still protects against a missing process. It is
  // deliberately marked as such so callers can apply stricter policy on
  // platforms where a start token is unavailable.
  return { pid, source: "pid" };
}

/**
 * Compare a previously captured identity with the currently running process.
 */
export async function matchesProcessIdentity(expected: ProcessIdentity): Promise<boolean> {
  const current = await getProcessIdentity(expected.pid);
  if (!current || current.pid !== expected.pid) {
    return false;
  }

  // PID-only is the best available answer on platforms without a portable
  // creation-time API. Callers can reject this source when they require
  // strong PID-reuse protection.
  if (!expected.startToken || !current.startToken) {
    return expected.source === "pid" && current.pid === expected.pid;
  }

  return expected.startToken === current.startToken;
}

/**
 * Alias used by lifecycle callers that think in terms of capture semantics.
 */
export const captureProcessIdentity = getProcessIdentity;

async function getLinuxProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) {
      return null;
    }

    // The text after the final ')' starts at field 3 (`state`). Linux's
    // `starttime` is field 22, therefore index 19 in this zero-based slice.
    const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) {
      return null;
    }

    let bootId = "";
    try {
      bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    } catch {
      // The process start ticks are still useful when boot_id is unavailable.
    }

    return {
      pid,
      source: "procfs",
      startToken: bootId ? `${bootId}:${startTicks}` : startTicks,
    };
  } catch {
    return null;
  }
}

async function getPsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    const startToken = stdout.trim().replace(/\s+/g, " ");
    return startToken ? { pid, source: "ps", startToken } : null;
  } catch {
    return null;
  }
}
