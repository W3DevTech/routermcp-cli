import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrowserManagementError,
  BrowserManagementSessionStore,
  ManagementCredentialStore,
  browserChallengeSigningPayload,
} from "../../../src/control-plane/index.js";

function createBrowserKey() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ format: "jwk" });
  return {
    publicKey,
    sign: (payload: Uint8Array) => sign(null, payload, keyPair.privateKey).toString("base64url"),
  };
}

describe("BrowserManagementSessionStore", () => {
  it("enrolls a public key and exchanges a signed challenge for a fresh host grant", async () => {
    const browser = createBrowserKey();
    const credentials = new ManagementCredentialStore({ generateToken: () => "fresh-management-token" });
    const store = new BrowserManagementSessionStore({ instanceId: "daemon-instance" });
    const device = await store.register({ publicKey: browser.publicKey, label: "Ashutosh laptop" });
    const challenge = store.issueChallenge();
    const result = await store.exchange(
      {
        deviceId: device.id,
        challengeId: challenge.challengeId,
        signature: browser.sign(browserChallengeSigningPayload(challenge)),
      },
      credentials,
    );

    expect(result.grant).toMatchObject({
      token: "fresh-management-token",
      authority: "host",
      scope: "management",
    });
    expect(credentials.authorize(result.grant.token)).toBe(true);
    expect(result.device).toMatchObject({ id: device.id, label: "Ashutosh laptop" });
    expect(JSON.stringify(result.device)).not.toContain(browser.publicKey.x);
  });

  it("rejects replay and expired challenges", async () => {
    let now = 1_000;
    const browser = createBrowserKey();
    const credentials = new ManagementCredentialStore({ generateToken: () => "token" });
    const store = new BrowserManagementSessionStore({
      instanceId: "daemon-instance",
      now: () => now,
      challengeTtlMs: 100,
    });
    const device = await store.register({ publicKey: browser.publicKey });
    const challenge = store.issueChallenge();
    const request = {
      deviceId: device.id,
      challengeId: challenge.challengeId,
      signature: browser.sign(browserChallengeSigningPayload(challenge)),
    };
    await store.exchange(request, credentials);
    await expect(store.exchange(request, credentials)).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });

    const expired = store.issueChallenge();
    now += 101;
    await expect(
      store.exchange(
        {
          deviceId: device.id,
          challengeId: expired.challengeId,
          signature: browser.sign(browserChallengeSigningPayload(expired)),
        },
        credentials,
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects forged signatures and allows the legitimate browser to retry", async () => {
    const browser = createBrowserKey();
    const otherBrowser = createBrowserKey();
    const credentials = new ManagementCredentialStore({ generateToken: () => "token" });
    const store = new BrowserManagementSessionStore({ instanceId: "daemon-instance" });
    const device = await store.register({ publicKey: browser.publicKey });
    const challenge = store.issueChallenge();
    const input = {
      deviceId: device.id,
      challengeId: challenge.challengeId,
      signature: otherBrowser.sign(browserChallengeSigningPayload(challenge)),
    };
    await expect(store.exchange(input, credentials)).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(
      await store.exchange(
        { ...input, signature: browser.sign(browserChallengeSigningPayload(challenge)) },
        credentials,
      ),
    ).toMatchObject({ grant: { token: "token" } });
  });

  it("stops a removed device from exchanging challenges and stores only public material", async () => {
    const browser = createBrowserKey();
    const temp = await mkdtemp(join(tmpdir(), "routermcp-browser-management-"));
    const path = join(temp, "devices.json");
    const credentials = new ManagementCredentialStore({ generateToken: () => "token" });
    const store = new BrowserManagementSessionStore({ instanceId: "daemon-instance", path });
    const device = await store.register({ publicKey: browser.publicKey });
    const persistedBeforeRevoke = await readFile(path, "utf8");
    expect(persistedBeforeRevoke).toContain(device.publicKeyFingerprint);
    expect(persistedBeforeRevoke).toContain(browser.publicKey.x);
    expect(persistedBeforeRevoke).not.toContain('"d"');
    const reloaded = new BrowserManagementSessionStore({ instanceId: "new-daemon-instance", path });
    await reloaded.initialize();
    expect(reloaded.list()).toEqual([device]);
    expect(await store.revoke(device.id)).toBe(true);
    expect(await store.revoke(device.id)).toBe(false);
    const challenge = store.issueChallenge();
    await expect(
      store.exchange(
        {
          deviceId: device.id,
          challengeId: challenge.challengeId,
          signature: browser.sign(browserChallengeSigningPayload(challenge)),
        },
        credentials,
      ),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("privateKey");
  });

  it("serializes concurrent persisted device updates", async () => {
    const temp = await mkdtemp(join(tmpdir(), "routermcp-browser-management-concurrent-"));
    const path = join(temp, "devices.json");
    const store = new BrowserManagementSessionStore({ instanceId: "daemon-instance", path });
    const browsers = Array.from({ length: 8 }, () => createBrowserKey());

    const devices = await Promise.all(
      browsers.map((browser, index) => store.register({
        publicKey: browser.publicKey,
        label: `Browser ${index}`,
      })),
    );

    const reloaded = new BrowserManagementSessionStore({ instanceId: "new-daemon-instance", path });
    await reloaded.initialize();
    expect(reloaded.list()).toHaveLength(devices.length);
    expect(reloaded.list()).toEqual(expect.arrayContaining(devices));
  });

  it("does not permit a workspace-scoped credential store to issue a browser host grant", async () => {
    const browser = createBrowserKey();
    const credentials = new ManagementCredentialStore({
      authority: "workspace",
      workspaceId: "workspace-a",
      generateToken: () => "token",
    });
    const store = new BrowserManagementSessionStore({ instanceId: "daemon-instance" });
    const device = await store.register({ publicKey: browser.publicKey });
    const challenge = store.issueChallenge();
    await expect(
      store.exchange(
        {
          deviceId: device.id,
          challengeId: challenge.challengeId,
          signature: browser.sign(browserChallengeSigningPayload(challenge)),
        },
        credentials,
      ),
    ).rejects.toThrow(BrowserManagementError);
    expect(credentials.size).toBe(0);
  });
});
