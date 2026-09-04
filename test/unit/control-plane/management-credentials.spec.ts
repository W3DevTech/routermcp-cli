import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS,
  MAX_MANAGEMENT_CREDENTIAL_TTL_MS,
  MANAGEMENT_CREDENTIAL_SCOPE,
  ManagementCredentialStore,
} from "../../../src/control-plane/index.js";

describe("ManagementCredentialStore", () => {
  it("issues an expiring scoped grant without retaining its raw token", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new ManagementCredentialStore({
      now: () => now,
      generateToken: () => "management-token",
    });

    const grant = store.issue();

    expect(grant).toEqual({
      token: "management-token",
      expiresAt: new Date(now + DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS).toISOString(),
      scope: MANAGEMENT_CREDENTIAL_SCOPE,
    });
    expect(store.authorize(grant.token)).toBe(true);
    expect(store.size).toBe(1);
    expect(JSON.stringify(store)).not.toContain(grant.token);

    now += DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS;
    expect(store.authorize(grant.token)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("revokes grants and rejects malformed or unknown tokens", () => {
    const store = new ManagementCredentialStore({ generateToken: () => "known-token" });
    const grant = store.issue();

    expect(store.authorize(undefined)).toBe(false);
    expect(store.authorize("known-token-extra")).toBe(false);
    expect(store.revoke("unknown-token")).toBe(false);
    expect(store.revoke(grant.token)).toBe(true);
    expect(store.revoke(grant.token)).toBe(false);
    expect(store.authorize(grant.token)).toBe(false);
  });

  it("evicts the oldest active grant when the bounded store is full", () => {
    let now = 1_000;
    let sequence = 0;
    const store = new ManagementCredentialStore({
      now: () => now,
      maxCredentials: 2,
      generateToken: () => `token-${++sequence}`,
    });

    const first = store.issue();
    now += 1;
    const second = store.issue();
    now += 1;
    const third = store.issue();

    expect(store.authorize(first.token)).toBe(false);
    expect(store.authorize(second.token)).toBe(true);
    expect(store.authorize(third.token)).toBe(true);
    expect(store.size).toBe(2);
  });

  it("rejects a TTL longer than the handoff safety bound", () => {
    expect(
      () => new ManagementCredentialStore({ ttlMs: MAX_MANAGEMENT_CREDENTIAL_TTL_MS + 1 }),
    ).toThrow(/no greater than/);
  });
});
