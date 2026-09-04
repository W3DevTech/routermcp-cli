import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  captureProcessIdentity,
  isProcessRunning,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./identity.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_STALE_AFTER_MS = 5 * 60_000;
export const DEFAULT_LOCK_RETRY_INTERVAL_MS = 50;

export interface LockOwner {
  lockId: string;
  pid: number;
  acquiredAt: string;
  processIdentity?: ProcessIdentity;
}

export interface AcquireProfileLockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  retryIntervalMs?: number;
  owner?: LockOwner;
}

export interface ProfileLock {
  readonly path: string;
  readonly owner: LockOwner;
  release(): Promise<void>;
}

export class ProfileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for RouterMCP profile lock: ${lockPath}`);
    this.name = "ProfileLockTimeoutError";
  }
}

/**
 * Acquire an exclusive lock for one profile. Lock acquisition is safe for
 * concurrent CLI processes because creation uses the filesystem's exclusive
 * `wx` flag. A dead owner's lock can be recovered after identity checks.
 */
export async function acquireProfileLock(
  lockPath: string,
  options: AcquireProfileLockOptions = {},
): Promise<ProfileLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;
  const owner = options.owner ?? (await createLockOwner());
  const deadline = Date.now() + Math.max(0, timeoutMs);

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(lockPath), 0o700);

  while (true) {
    if (await tryCreateLock(lockPath, owner)) {
      return createProfileLock(lockPath, owner);
    }

    await removeStaleLock(lockPath, staleAfterMs);

    // A stale lock may have been removed above, so make one more attempt
    // before checking the deadline.
    if (await tryCreateLock(lockPath, owner)) {
      return createProfileLock(lockPath, owner);
    }

    if (Date.now() >= deadline) {
      throw new ProfileLockTimeoutError(lockPath, timeoutMs);
    }

    await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Attempt one acquisition without waiting for an active owner. Stale locks
 * are recovered using the same process-identity checks as acquireProfileLock.
 */
export async function tryAcquireProfileLock(
  lockPath: string,
  options: Omit<AcquireProfileLockOptions, "timeoutMs"> = {},
): Promise<ProfileLock | null> {
  const owner = options.owner ?? (await createLockOwner());
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(lockPath), 0o700);

  if (await tryCreateLock(lockPath, owner)) {
    return createProfileLock(lockPath, owner);
  }

  if (await removeStaleLock(lockPath, options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS)) {
    return (await tryCreateLock(lockPath, owner)) ? createProfileLock(lockPath, owner) : null;
  }

  return null;
}

/** Run a callback while holding a profile lock and always release it. */
export async function withProfileLock<T>(
  lockPath: string,
  callback: (lock: ProfileLock) => Promise<T> | T,
  options: AcquireProfileLockOptions = {},
): Promise<T> {
  const lock = await acquireProfileLock(lockPath, options);
  try {
    return await callback(lock);
  } finally {
    await lock.release();
  }
}

async function createLockOwner(): Promise<LockOwner> {
  const pid = process.pid;
  return {
    lockId: randomUUID(),
    pid,
    acquiredAt: new Date().toISOString(),
    processIdentity: (await captureProcessIdentity(pid)) ?? { pid, source: "pid" },
  };
}

async function tryCreateLock(lockPath: string, owner: LockOwner): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(lockPath, 0o600);
    return true;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }

    // If writing or flushing a newly-created lock failed, do not leave an
    // orphaned file that would unnecessarily block every future contender.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(lockPath).catch(() => undefined);
    }

    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let owner: LockOwner | null = null;
  let modifiedAt: number;
  let inode: number;
  let size: number;

  try {
    const [content, metadata] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    modifiedAt = metadata.mtimeMs;
    inode = metadata.ino;
    size = metadata.size;
    owner = parseLockOwner(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }

  let stale = false;
  if (!owner) {
    stale = Date.now() - modifiedAt >= staleAfterMs;
  } else if (owner.processIdentity) {
    stale = !(await matchesProcessIdentity(owner.processIdentity));
  } else {
    stale = !isProcessRunning(owner.pid);
  }

  if (!stale) {
    return false;
  }

  try {
    // The lock may have been replaced while the owner identity was being
    // checked. Re-stat the same pathname before unlinking so a stale-owner
    // cleanup cannot remove a newer contender's lock.
    const current = await stat(lockPath);
    if (current.ino !== inode || current.mtimeMs !== modifiedAt || current.size !== size) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    // Another contender may have recovered the lock first.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }
}

function parseLockOwner(content: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.lockId !== "string" ||
      record.lockId.length === 0 ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.acquiredAt !== "string"
    ) {
      return null;
    }

    return record as unknown as LockOwner;
  } catch {
    return null;
  }
}

function createProfileLock(lockPath: string, owner: LockOwner): ProfileLock {
  let released = false;

  return {
    path: lockPath,
    owner,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;

      try {
        const content = await readFile(lockPath, "utf8");
        const current = parseLockOwner(content);
        if (current?.lockId === owner.lockId) {
          await unlink(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
