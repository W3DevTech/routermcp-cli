import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      // Leave a pre-directory lock untouched. The caller will wait for it to
      // disappear rather than risking a pathname replacement race.
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    // Do not clean up by pathname here. Another process can recover this
    // directory after mkdir() and create a replacement lock before this
    // error handler runs. A pathname-based unlink/rmdir could then remove
    // that replacement. The failed directory is intentionally left for the
    // stale-lock path, which uses ownership-aware cleanup below.

    throw error;
  }
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let owner: LockOwner | null = null;
  let observedOwnerContent: string | null = null;
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
        observedOwnerContent = await readFile(ownerPath(lockPath), "utf8");
        owner = parseLockOwner(observedOwnerContent);
      }
    } else {
      // A file here is a pre-directory RouterMCP lock. Read it only to detect
      // a dead legacy owner; a live legacy process remains authoritative.
      isLegacyFile = true;
      modifiedAt = metadata.mtimeMs;
      observedOwnerContent = await readFile(lockPath, "utf8");
      owner = parseLockOwner(observedOwnerContent);
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
      // Re-read the legacy record after the identity check. New contenders
      // use the directory primitive below, so an unlink that races with a
      // replacement directory fails without moving or deleting that owner.
      // Comparing the content also avoids deleting a replacement legacy
      // record that appeared while the stale check was in flight.
      const currentContent = await readFile(lockPath, "utf8");
      if (currentContent !== observedOwnerContent) {
        return false;
      }
      await unlink(lockPath);
      return true;
    }

    if (!isDirectory) return false;

    if (observedOwnerContent === null) {
      // An owner record may not have been published yet (for example, a
      // process can exit immediately after mkdir). A stale cleaner can also
      // have crashed after quarantining owner.json, so recover those private
      // artifacts before attempting the directory removal.
      if (!(await recoverQuarantinedOwners(lockPath, staleAfterMs))) {
        return false;
      }

      // rmdir() is deliberately attempted while the directory is still
      // empty; if another writer has published a record first, ENOTEMPTY
      // leaves the lock intact.
      await rmdir(lockPath);
      return true;
    }

    // Move the exact record that was inspected out of the lock directory.
    // This closes the unlink-then-rmdir window: the owner process cannot
    // publish a replacement directory while this directory still exists,
    // and a concurrent release sees the missing owner record and becomes a
    // no-op. Re-read the quarantined record before deleting it so a record
    // that changed after the stale check is restored instead of discarded.
    const quarantinedOwnerPath = `${ownerPath(lockPath)}.stale-${randomUUID()}`;
    await rename(ownerPath(lockPath), quarantinedOwnerPath);

    const quarantinedContent = await readFile(quarantinedOwnerPath, "utf8");
    if (quarantinedContent !== observedOwnerContent) {
      await restoreQuarantinedFile(quarantinedOwnerPath, ownerPath(lockPath));
      return false;
    }

    await unlink(quarantinedOwnerPath);
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

      const quarantinedOwnerPath = `${ownerPath(lockPath)}.release-${randomUUID()}`;
      try {
        // Quarantine the record before deleting it. Reading first and then
        // unlinking leaves a window in which stale recovery can remove and a
        // replacement owner can acquire the directory; a delayed release
        // would otherwise unlink that replacement's owner record.
        await rename(ownerPath(lockPath), quarantinedOwnerPath);
        const content = await readFile(quarantinedOwnerPath, "utf8");
        const current = parseLockOwner(content);
        if (current?.lockId === owner.lockId) {
          await unlink(quarantinedOwnerPath);
          // A stale-cleanup pass may have restored this live record while it
          // was quarantined. Remove that same owner record before removing
          // the directory; otherwise rmdir() would leave an owned lock
          // behind after a perfectly valid release.
          await unlinkOwnedOwnerRecord(lockPath, owner.lockId);
          await rmdir(lockPath).catch((rmdirError: unknown) => {
            const code = (rmdirError as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY") throw rmdirError;
          });
        } else {
          await restoreQuarantinedFile(quarantinedOwnerPath, ownerPath(lockPath));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

async function unlinkOwnedOwnerRecord(lockPath: string, lockId: string): Promise<void> {
  try {
    const path = ownerPath(lockPath);
    const content = await readFile(path, "utf8");
    if (parseLockOwner(content)?.lockId === lockId) {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Restore a quarantined regular file without replacing a file that appeared
 * at the destination while the quarantine operation was in flight. A hard
 * link is atomic and fails with EEXIST instead of overwriting that file.
 */
async function restoreQuarantinedFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await link(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }

  await unlink(sourcePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/**
 * Finish an interrupted owner-record quarantine. The suffixes are private,
 * random names generated by this module; unrelated files in a profile
 * directory are never removed. A live owner is restored instead of being
 * treated as an empty stale directory.
 */
async function recoverQuarantinedOwners(
  lockPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!/^owner\.json\.(?:stale|release)-[A-Za-z0-9-]+$/.test(entry)) {
      continue;
    }

    const quarantinedPath = join(lockPath, entry);
    let metadata;
    let content: string;
    try {
      metadata = await stat(quarantinedPath);
      content = await readFile(quarantinedPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const candidate = parseLockOwner(content);
    if (candidate) {
      const live = candidate.processIdentity
        ? await matchesProcessIdentity(candidate.processIdentity)
        : isProcessRunning(candidate.pid);
      if (live) {
        await restoreQuarantinedFile(quarantinedPath, ownerPath(lockPath));
        return false;
      }
    } else if (Date.now() - metadata.mtimeMs < staleAfterMs) {
      // A creator may still be writing a record. Leave a fresh malformed
      // artifact alone until the normal stale window has elapsed.
      return false;
    }

    await unlink(quarantinedPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  return true;
}

function ownerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
