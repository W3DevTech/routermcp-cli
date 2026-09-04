import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityControl = vi.hoisted(() => {
  let releaseIdentityCheck: (() => void) | undefined;
  let identityCheckStarted: (() => void) | undefined;

  return {
    match: false,
    waitForIdentityCheck: false,
    beginIdentityCheck: () =>
      new Promise<void>((resolve) => {
        identityCheckStarted = resolve;
      }),
    signalIdentityCheck: () => identityCheckStarted?.(),
    release: () => releaseIdentityCheck?.(),
    wait: () =>
      new Promise<void>((resolve) => {
        releaseIdentityCheck = resolve;
      }),
    reset: () => {
      identityControl.match = false;
      identityControl.waitForIdentityCheck = false;
      releaseIdentityCheck = undefined;
      identityCheckStarted = undefined;
    },
  };
});

vi.mock("../../../src/daemon/identity.js", () => ({
  captureProcessIdentity: vi.fn(async (pid: number) => ({ pid, source: "pid" })),
  isProcessRunning: vi.fn(() => true),
  matchesProcessIdentity: vi.fn(async () => {
    if (identityControl.waitForIdentityCheck) {
      identityControl.signalIdentityCheck();
      await identityControl.wait();
    }
    return identityControl.match;
  }),
}));

import { tryAcquireProfileLock } from "../../../src/daemon/lock.js";

describe("profile lock stale recovery races", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    identityControl.reset();
    tempDir = join(process.env.TMPDIR ?? "/tmp", `routermcp-lock-race-${randomUUID()}`);
    lockPath = join(tempDir, "daemon.lock");
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    identityControl.reset();
    await unlink(join(lockPath, "owner.json")).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
    await rmdir(tempDir).catch(() => undefined);
  });

  it("does not discard a replacement owner after the stale identity check", async () => {
    const staleOwner = {
      lockId: "stale-owner",
      pid: 999_999_999,
      acquiredAt: new Date(0).toISOString(),
      processIdentity: { pid: 999_999_999, source: "pid" },
    };
    const replacementOwner = {
      lockId: "replacement-owner",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      processIdentity: { pid: process.pid, source: "pid" },
    };

    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(staleOwner)}\n`);

    identityControl.waitForIdentityCheck = true;
    const identityCheckStarted = identityControl.beginIdentityCheck();
    const attempt = tryAcquireProfileLock(lockPath);
    await identityCheckStarted;

    // Model the observed stale owner disappearing and a new contender
    // acquiring the directory before stale cleanup resumes.
    await unlink(join(lockPath, "owner.json"));
    await rmdir(lockPath);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(replacementOwner)}\n`);

    identityControl.release();
    const acquired = await attempt;

    expect(acquired).toBeNull();
    expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe(
      `${JSON.stringify(replacementOwner)}\n`,
    );
  });

  it("does not unlink a replacement directory during legacy recovery", async () => {
    const staleOwner = {
      lockId: "stale-legacy-owner",
      pid: 999_999_999,
      acquiredAt: new Date(0).toISOString(),
      processIdentity: { pid: 999_999_999, source: "pid" },
    };
    const replacementOwner = {
      lockId: "replacement-directory-owner",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      processIdentity: { pid: process.pid, source: "pid" },
    };

    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`);

    identityControl.waitForIdentityCheck = true;
    const identityCheckStarted = identityControl.beginIdentityCheck();
    const attempt = tryAcquireProfileLock(lockPath);
    await identityCheckStarted;

    // A legacy owner can release its file between the stale check and
    // cleanup. A managed contender may then acquire the path as a directory.
    await unlink(lockPath);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(replacementOwner)}\n`);

    identityControl.release();
    const acquired = await attempt;

    expect(acquired).toBeNull();
    expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe(
      `${JSON.stringify(replacementOwner)}\n`,
    );
  });
});
