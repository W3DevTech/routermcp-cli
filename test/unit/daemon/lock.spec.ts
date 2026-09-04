import { chmod, mkdir, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireProfileLock,
  ProfileLockTimeoutError,
  tryAcquireProfileLock,
  withProfileLock,
} from "../../../src/daemon/lock.js";
import { cleanupTempDir, createTempDir, wait } from "../../helpers/test-utils.js";

describe("profile lock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    lockPath = join(tempDir, "daemon.lock");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("serializes concurrent holders and writes a private lock file", async () => {
    let active = 0;
    let maximum = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withProfileLock(
          lockPath,
          async () => {
            active++;
            maximum = Math.max(maximum, active);
            await wait(5);
            active--;
          },
          { timeoutMs: 2_000, retryIntervalMs: 1 },
        ),
      ),
    );

    expect(maximum).toBe(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null while another live owner holds the lock", async () => {
    const first = await acquireProfileLock(lockPath);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o700);

    const second = await tryAcquireProfileLock(lockPath, { staleAfterMs: 1 });
    expect(second).toBeNull();

    await first.release();
    expect(await tryAcquireProfileLock(lockPath)).not.toBeNull();
  });

  it("recovers a lock whose recorded process is gone", async () => {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        lockId: "stale-lock",
        pid: 999_999_999,
        acquiredAt: new Date(0).toISOString(),
        processIdentity: { pid: 999_999_999, source: "pid" },
      }),
    );
    await chmod(join(lockPath, "owner.json"), 0o600);

    const lock = await tryAcquireProfileLock(lockPath);
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it("recovers a lock whose process start identity no longer matches", async () => {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        lockId: "reused-pid-lock",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        processIdentity: {
          pid: process.pid,
          source: "pid",
          startToken: "different-process-start",
        },
      }),
    );

    const lock = await tryAcquireProfileLock(lockPath);
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it("recovers an old malformed lock but does not steal a fresh one", async () => {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), "partial");
    const fresh = await tryAcquireProfileLock(lockPath, { staleAfterMs: 60_000 });
    expect(fresh).toBeNull();

    const old = Date.now() - 120_000;
    await utimes(join(lockPath, "owner.json"), old / 1000, old / 1000);
    const recovered = await tryAcquireProfileLock(lockPath, { staleAfterMs: 1_000 });
    expect(recovered).not.toBeNull();
    await recovered?.release();
  });

  it("times out on an active owner", async () => {
    const first = await acquireProfileLock(lockPath);

    await expect(
      acquireProfileLock(lockPath, { timeoutMs: 10, retryIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(ProfileLockTimeoutError);

    await first.release();
  });

  it("does not remove a replacement lock during release", async () => {
    const first = await acquireProfileLock(lockPath);
    await unlink(join(lockPath, "owner.json"));
    await rmdir(lockPath);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        lockId: "replacement-lock",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        processIdentity: { pid: process.pid, source: "pid" },
      }),
    );

    await first.release();
    const second = await tryAcquireProfileLock(lockPath);
    expect(second).toBeNull();

    await unlink(join(lockPath, "owner.json"));
    await rmdir(lockPath);
  });
});
