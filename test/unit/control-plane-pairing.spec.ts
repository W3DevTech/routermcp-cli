import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAIRING_GRANT_TTL_MS,
  DEFAULT_PAIRING_SCOPES,
  IssuedPairingGrantSchema,
  MAX_PAIRING_GRANT_TTL_MS,
  MANAGEMENT_PAIRING_SCOPES,
  MIN_PAIRING_GRANT_TTL_MS,
  PairingChallengeMismatchError,
  PairingGrantCapacityError,
  PairingGrantConsumedError,
  PairingGrantExpiredError,
  PairingGrantInputError,
  PairingGrantNotFoundError,
  PairingGrantRecordSchema,
  PairingGrantRevokedError,
  PairingGrantExchangeRequestSchema,
  PairingGrantExchangeResponseSchema,
  PairingGrantStore,
  PAIRING_PROTOCOL_VERSION,
  toPairingGrantExchangeResponse,
} from "../../src/control-plane/pairing.js";

const context = {
  profileId: "profile-1",
  instanceId: "instance-1",
};

describe("PairingGrantStore", () => {
  it("issues high-entropy metadata with a separate challenge and no public credential field", () => {
    const store = new PairingGrantStore({ now: () => Date.parse("2026-01-01T00:00:00.000Z") });
    const issued = store.issue({ ...context, scopes: MANAGEMENT_PAIRING_SCOPES, label: "Browser" });

    expect(issued.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.challenge.id).not.toBe(issued.id);
    expect(issued).not.toHaveProperty("localAuthToken");
    expect(store.list(context)).toEqual([
      expect.objectContaining({
        id: issued.id,
        scopes: [...MANAGEMENT_PAIRING_SCOPES],
        state: "pending",
        challengeId: issued.challenge.id,
      }),
    ]);
    expect(store.list(context)[0]).not.toHaveProperty("credential");
    expect(store.list(context)[0]).not.toHaveProperty("nonce");
    expect(PairingGrantRecordSchema.parse(store.list(context)[0])).toBeTruthy();
    expect(IssuedPairingGrantSchema.parse(issued)).toBeTruthy();
  });

  it("uses the shipped management scope by default and keeps scopes isolated", () => {
    const store = new PairingGrantStore({ now: () => 1_700_000_000_000 });
    const issued = store.issue(context);

    expect(issued.scopes).toEqual([...DEFAULT_PAIRING_SCOPES]);
    issued.scopes = ["peering:write"];
    expect(store.get(issued.id, context)?.scopes).toEqual([...DEFAULT_PAIRING_SCOPES]);
  });

  it("consumes a grant once only after both challenge values match", () => {
    const store = new PairingGrantStore({ now: () => 1_700_000_000_000 });
    const issued = store.issue(context);

    expect(() =>
      store.consume({
        ...context,
        credential: issued.credential,
        challengeId: issued.challenge.id,
        nonce: "wrong",
      }),
    ).toThrowError(PairingChallengeMismatchError);
    expect(store.get(issued.id, context)?.state).toBe("pending");

    const consumed = store.consume({
      ...context,
      credential: issued.credential,
      challengeId: issued.challenge.id,
      nonce: issued.challenge.nonce,
    });
    const response = toPairingGrantExchangeResponse(consumed);
    expect(PairingGrantExchangeResponseSchema.parse(response)).toEqual(response);
    expect(consumed).toMatchObject({
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      grantId: issued.id,
      profileId: context.profileId,
      instanceId: context.instanceId,
    });
    expect(consumed).not.toHaveProperty("credential");
    expect(consumed).not.toHaveProperty("localAuthToken");
    expect(store.get(issued.id, context)).toMatchObject({ state: "consumed" });
    expect(() =>
      store.consume({
        ...context,
        credential: issued.credential,
        challengeId: issued.challenge.id,
        nonce: issued.challenge.nonce,
      }),
    ).toThrowError(PairingGrantConsumedError);
  });

  it("does not disclose a grant across profile or daemon instance boundaries", () => {
    const store = new PairingGrantStore({ now: () => 1_700_000_000_000 });
    const issued = store.issue(context);

    expect(store.get(issued.id, { ...context, profileId: "other-profile" })).toBeNull();
    expect(() =>
      store.consume({
        profileId: "other-profile",
        instanceId: context.instanceId,
        credential: issued.credential,
        challengeId: issued.challenge.id,
        nonce: issued.challenge.nonce,
      }),
    ).toThrowError(PairingGrantNotFoundError);
    expect(store.get(issued.id, context)?.state).toBe("pending");
  });

  it("expires pending grants and refuses exchanges after the TTL", () => {
    let now = 1_700_000_000_000;
    const store = new PairingGrantStore({ now: () => now, defaultTtlMs: MIN_PAIRING_GRANT_TTL_MS });
    const issued = store.issue(context);

    now += MIN_PAIRING_GRANT_TTL_MS;
    expect(store.expire()).toBe(1);
    expect(store.get(issued.id, context)).toMatchObject({ state: "expired", expiredAt: expect.any(String) });
    expect(() =>
      store.consume({
        ...context,
        credential: issued.credential,
        challengeId: issued.challenge.id,
        nonce: issued.challenge.nonce,
      }),
    ).toThrowError(PairingGrantExpiredError);
    expect(store.list(context)).toEqual([]);
    expect(store.list(context, { includeInactive: true })).toEqual([
      expect.objectContaining({ id: issued.id, state: "expired" }),
    ]);
  });

  it("revokes pending grants without allowing a later exchange", () => {
    const store = new PairingGrantStore({ now: () => 1_700_000_000_000 });
    const issued = store.issue(context);

    expect(store.revoke(issued.id, context)).toBe(true);
    expect(store.revoke(issued.id, context)).toBe(false);
    expect(store.get(issued.id, context)).toMatchObject({ state: "revoked", revokedAt: expect.any(String) });
    expect(() =>
      store.consume({
        ...context,
        credential: issued.credential,
        challengeId: issued.challenge.id,
        nonce: issued.challenge.nonce,
      }),
    ).toThrowError(PairingGrantRevokedError);
  });

  it("bounds TTLs and rejects unknown or duplicate capabilities", () => {
    expect(
      () => new PairingGrantStore({ defaultTtlMs: MIN_PAIRING_GRANT_TTL_MS - 1 }),
    ).toThrowError(PairingGrantInputError);
    expect(
      () => new PairingGrantStore({ defaultTtlMs: MAX_PAIRING_GRANT_TTL_MS + 1 }),
    ).toThrowError(PairingGrantInputError);

    const store = new PairingGrantStore({ now: () => 1_700_000_000_000 });
    expect(() => store.issue({ ...context, ttlMs: DEFAULT_PAIRING_GRANT_TTL_MS + 1 })).not.toThrow();
    expect(() => store.issue({ ...context, scopes: ["management", "management"] })).toThrow(
      "Duplicate pairing scope",
    );
    expect(() =>
      store.issue({ ...context, scopes: ["not-a-scope" as "management"] }),
    ).toThrow("Unsupported pairing scope");
    expect(() => store.issue({ ...context, scopes: ["peering:write"] })).toThrow(
      "Pairing scope is not enabled",
    );
  });

  it("evicts terminal records before refusing new grants at capacity", () => {
    const store = new PairingGrantStore({ now: () => 1_700_000_000_000, maxGrants: 1 });
    const first = store.issue(context);
    expect(store.revoke(first.id, context)).toBe(true);
    const second = store.issue(context);

    expect(second.id).not.toBe(first.id);
    expect(store.size).toBe(1);
    expect(() =>
      store.issue({ ...context, ttlMs: MIN_PAIRING_GRANT_TTL_MS, label: "capacity" }),
    ).toThrowError(PairingGrantCapacityError);
  });
});

describe("pairing protocol schemas", () => {
  it("requires an explicit protocol version for exchange", () => {
    const valid = {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      grant: "grant",
      challengeId: "00000000-0000-4000-8000-000000000000",
      nonce: "nonce",
    };
    expect(PairingGrantExchangeRequestSchema.parse(valid)).toEqual(valid);
    expect(() =>
      PairingGrantExchangeRequestSchema.parse({ ...valid, protocolVersion: "2" }),
    ).toThrow();
  });

  it("keeps the exchange response free of daemon authentication material", () => {
    const response = {
      accepted: true as const,
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      profileId: "profile-1",
      instanceId: "instance-1",
      grantId: "00000000-0000-4000-8000-000000000000",
      scopes: ["management" as const],
      subject: "hosted-console",
      expiresAt: "2026-01-01T00:05:00.000Z",
      consumedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(PairingGrantExchangeResponseSchema.parse(response)).toEqual(response);
    expect(response).not.toHaveProperty("localAuthToken");
    expect(response).not.toHaveProperty("credential");
  });
});
