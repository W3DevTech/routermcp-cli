import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * directory creation. A dead owner's lock can be recovered after identity checks.
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
  /**
   * A directory is the ownership primitive. `mkdir` is atomic and stale
   * recovery uses `rmdir`, which can only remove the exact empty directory it
   * observed; a replacement owner cannot be deleted by a later pathname
   * unlink. The owner record lives inside the directory and is never used as
   * the lock primitive itself.
   */
  try {
    await mkdir(lockPath, 0o700);
    await writeFile(ownerPath(lockPath), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(lockPath, 0o700);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      // Leave a pre-directory lock untouched. The caller will wait for it to
      // disappear rather than risking a pathname replacement race.
      return false;
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(ownerPath(lockPath)).catch(() => undefined);
      await rmdir(lockPath).catch(() => undefined);
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
  let isDirectory = false;
  let isLegacyFile = false;

  try {
    const metadata = await stat(lockPath);
    isDirectory = metadata.isDirectory();
    if (isDirectory) {
      const ownerMetadata = await stat(ownerPath(lockPath)).catch(() => null);
      modifiedAt = ownerMetadata?.mtimeMs ?? metadata.mtimeMs;
      if (ownerMetadata) {
        owner = parseLockOwner(await readFile(ownerPath(lockPath), "utf8"));
      }
    } else {
      // A file here is a pre-directory RouterMCP lock. Read it only to detect
      // a dead legacy owner; a live legacy process remains authoritative.
      isLegacyFile = true;
      modifiedAt = metadata.mtimeMs;
      owner = parseLockOwner(await readFile(lockPath, "utf8"));
    }
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
    if (isLegacyFile) {
      // New contenders use the directory primitive below, so quarantine the
      // old file before creating the directory. The old process identity was
      // checked above; retaining the file as a uniquely named artifact keeps
      // recovery auditable without leaving the profile wedged.
      await rename(lockPath, `${lockPath}.legacy-${randomUUID()}`);
      return true;
    }

    if (!isDirectory) return false;

    // Remove the owner record first, then rmdir the lock directory. A new
    // owner cannot create the directory until rmdir has completed, so this
    // sequence cannot unlink a replacement lock.
    await unlink(ownerPath(lockPath)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rmdir(lockPath);
    return true;
  } catch (error) {
    // Another contender may have recovered the lock first.
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
    ) {
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
        const content = await readFile(ownerPath(lockPath), "utf8");
        const current = parseLockOwner(content);
        if (current?.lockId === owner.lockId) {
          await unlink(ownerPath(lockPath));
          await rmdir(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

function ownerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
