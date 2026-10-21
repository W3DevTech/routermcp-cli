import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MANAGEMENT_CREDENTIAL_SCOPE,
  type ManagementCredentialGrant,
} from "./management-credentials.js";
import { CONTROL_PLANE_PATH } from "./paths.js";

/**
 * Version of the browser-to-daemon pairing contract.
 *
 * This is deliberately separate from DAEMON_PROTOCOL_VERSION. The daemon
 * protocol identifies the managed process/runtime contract, while this value
 * identifies the credential exchange understood by a hosted console.
 */
export const PAIRING_PROTOCOL_VERSION = "1" as const;

/**
 * Versioned paths for the browser-to-daemon pairing exchange. Grant issuance
 * and revocation remain local-authenticated; exchange is authenticated by the
 * one-time grant and challenge.
 */
export const CONTROL_PLANE_PAIRING_PATH = `${CONTROL_PLANE_PATH}/pairing` as const;
export const CONTROL_PLANE_PAIRING_GRANTS_PATH =
  `${CONTROL_PLANE_PAIRING_PATH}/grants` as const;
export const CONTROL_PLANE_PAIRING_EXCHANGE_PATH =
  `${CONTROL_PLANE_PAIRING_PATH}/exchange` as const;

/** User-facing links should be short-lived even when the daemon is persistent. */
export const DEFAULT_PAIRING_GRANT_TTL_MS = 5 * 60_000;
export const MIN_PAIRING_GRANT_TTL_MS = 30_000;
export const MAX_PAIRING_GRANT_TTL_MS = 15 * 60_000;
export const PAIRING_GRANT_SECRET_BYTES = 32;
export const PAIRING_CHALLENGE_NONCE_BYTES = 32;
export const DEFAULT_PAIRING_GRANT_CAPACITY = 256;

/**
 * Scopes are capabilities, not implementation details. The broad management
 * scope matches the currently shipped hosted console; peering scopes are
 * reserved for the later peer-management phase and must be requested
 * explicitly.
 */
export const PAIRING_SCOPES = [
  MANAGEMENT_CREDENTIAL_SCOPE,
  "peering:read",
  "peering:write",
] as const;
export type PairingScope = (typeof PAIRING_SCOPES)[number];

export const DEFAULT_PAIRING_SCOPES = [MANAGEMENT_CREDENTIAL_SCOPE] as const satisfies readonly PairingScope[];
export const MANAGEMENT_PAIRING_SCOPES = [MANAGEMENT_CREDENTIAL_SCOPE] as const satisfies readonly PairingScope[];
/** Peer capabilities stay disabled until peer routes have shipped and passed review. */
export const DEFAULT_PAIRING_ALLOWED_SCOPES = MANAGEMENT_PAIRING_SCOPES;

export const PAIRING_GRANT_STATES = ["pending", "consumed", "revoked", "expired"] as const;
export type PairingGrantState = (typeof PAIRING_GRANT_STATES)[number];

export interface PairingGrantContext {
  /** Stable profile identity; prevents a grant crossing config profiles. */
  profileId: string;
  /** Runtime instance identity; a daemon restart invalidates old grants. */
  instanceId: string;
  /** Optional workspace claim for a multi-workspace daemon host. */
  workspaceId?: string;
}

export interface PairingChallenge {
  /** Public identifier for the challenge; the nonce remains secret material. */
  id: string;
  /** High-entropy value that must accompany the one-time grant. */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/** Metadata safe to return from list/status endpoints. */
export interface PairingGrantRecord extends PairingGrantContext {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  id: string;
  scopes: readonly PairingScope[];
  subject: string;
  label?: string;
  /** Challenge id is useful for UI diagnostics; nonce is never listed. */
  challengeId: string;
  createdAt: string;
  expiresAt: string;
  state: PairingGrantState;
  consumedAt?: string;
  revokedAt?: string;
  expiredAt?: string;
}

/** Returned once, at issuance time. Never persist or include this in a list. */
export interface IssuedPairingGrant extends PairingGrantRecord {
  credential: string;
  challenge: PairingChallenge;
}

export interface PairingGrantIssueInput extends PairingGrantContext {
  scopes?: readonly PairingScope[];
  subject?: string;
  label?: string;
  ttlMs?: number;
}

export interface PairingGrantExchangeInput extends PairingGrantContext {
  credential: string;
  challengeId: string;
  nonce: string;
}

/**
 * Internal authorization produced by a successful exchange. The pairing
 * control uses this to mint a separate management credential. It intentionally
 * has no localAuthToken or other daemon bearer material.
 */
export interface ConsumedPairingGrant extends PairingGrantContext {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  grantId: string;
  scopes: readonly PairingScope[];
  subject: string;
  label?: string;
  expiresAt: string;
  consumedAt: string;
}

/** Local-authenticated HTTP request to issue a grant; the daemon supplies the context. */
export interface PairingGrantIssueRequest {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  scopes?: PairingScope[];
  subject?: string;
  label?: string;
  ttlMs?: number;
  /** Required when a host has more than one registered workspace. */
  workspaceId?: string;
}

export interface PairingGrantExchangeRequest {
  protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  grant: string;
  challengeId: string;
  nonce: string;
  /** Required when a host has more than one registered workspace. */
  workspaceId?: string;
}

/**
 * The exchange response is an authorization decision plus, for the management
 * scope, a separately scoped short-lived token. It never returns localAuthToken.
 */
export interface PairingGrantExchangeResponse extends ConsumedPairingGrant {
  accepted: true;
  /** Fresh browser credential; the daemon root token is never returned. */
  management?: ManagementCredentialGrant;
}

/** Serialize a successful internal authorization for the HTTP exchange route. */
export function toPairingGrantExchangeResponse(
  grant: ConsumedPairingGrant,
  management?: ManagementCredentialGrant,
): PairingGrantExchangeResponse {
  return {
    accepted: true,
    ...grant,
    scopes: [...grant.scopes],
    ...(management ? { management } : {}),
  };
}

/** Transport-facing pairing adapter. The CLI binds this to its host registry. */
export interface PairingControl {
  issue: (
    input: PairingGrantIssueRequest,
  ) => IssuedPairingGrant | Promise<IssuedPairingGrant>;
  list: (
    workspaceId: string | undefined,
    includeInactive: boolean,
  ) => PairingGrantRecord[] | Promise<PairingGrantRecord[]>;
  revoke: (
    id: string,
    workspaceId: string | undefined,
  ) => boolean | Promise<boolean>;
  exchange: (
    input: PairingGrantExchangeRequest,
  ) => PairingGrantExchangeResponse | Promise<PairingGrantExchangeResponse>;
}

export interface PairingControlOptions {
  grants: PairingGrantStore;
  /**
   * Bind a request's optional workspace claim to this daemon's profile and
   * instance. Returns null when the workspace is not registered here.
   */
  resolveContext: (workspaceId: string | undefined) => PairingGrantContext | null;
  /** Mint the browser credential returned for grants with the management scope. */
  issueManagementCredential?: (workspaceId: string | undefined) => ManagementCredentialGrant;
}

/** Bind a grant store to the daemon's host registry for the HTTP transport. */
export function createPairingControl(options: PairingControlOptions): PairingControl {
  const { grants, resolveContext, issueManagementCredential } = options;
  return {
    issue: (input) => {
      const context = resolveContext(input.workspaceId);
      if (!context) {
        throw new PairingGrantInputError("Pairing workspace is not registered with this daemon");
      }
      const { protocolVersion: _version, workspaceId: _workspaceId, ...grant } = input;
      return grants.issue({ ...grant, ...context });
    },
    list: (workspaceId, includeInactive) => {
      const context = resolveContext(workspaceId);
      return context ? grants.list(context, { includeInactive }) : [];
    },
    revoke: (id, workspaceId) => {
      const context = resolveContext(workspaceId);
      return context ? grants.revoke(id, context) : false;
    },
    exchange: (input) => {
      // Unauthenticated route: an unknown workspace looks like an unknown grant.
      const context = resolveContext(input.workspaceId);
      if (!context) throw new PairingGrantNotFoundError();
      const consumed = grants.consume({
        ...context,
        credential: input.grant,
        challengeId: input.challengeId,
        nonce: input.nonce,
      });
      const management = consumed.scopes.includes(MANAGEMENT_CREDENTIAL_SCOPE)
        ? issueManagementCredential?.(consumed.workspaceId)
        : undefined;
      return toPairingGrantExchangeResponse(consumed, management);
    },
  };
}

export interface PairingGrantListOptions {
  includeInactive?: boolean;
}

export interface PairingGrantStoreOptions {
  now?: () => number;
  maxGrants?: number;
  defaultTtlMs?: number;
  /** Capabilities this daemon currently permits issuers to delegate. */
  allowedScopes?: readonly PairingScope[];
}

export class PairingGrantError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PairingGrantError";
  }
}

export class PairingGrantInputError extends PairingGrantError {
  constructor(message: string) {
    super(message, "PAIRING_GRANT_INVALID_INPUT");
    this.name = "PairingGrantInputError";
  }
}

export class PairingGrantNotFoundError extends PairingGrantError {
  constructor() {
    super("Pairing grant was not found", "PAIRING_GRANT_NOT_FOUND");
    this.name = "PairingGrantNotFoundError";
  }
}

export class PairingGrantExpiredError extends PairingGrantError {
  constructor() {
    super("Pairing grant has expired", "PAIRING_GRANT_EXPIRED");
    this.name = "PairingGrantExpiredError";
  }
}

export class PairingGrantRevokedError extends PairingGrantError {
  constructor() {
    super("Pairing grant has been revoked", "PAIRING_GRANT_REVOKED");
    this.name = "PairingGrantRevokedError";
  }
}

export class PairingGrantConsumedError extends PairingGrantError {
  constructor() {
    super("Pairing grant has already been consumed", "PAIRING_GRANT_CONSUMED");
    this.name = "PairingGrantConsumedError";
  }
}

export class PairingChallengeMismatchError extends PairingGrantError {
  constructor() {
    super("Pairing challenge did not match the grant", "PAIRING_CHALLENGE_MISMATCH");
    this.name = "PairingChallengeMismatchError";
  }
}

export class PairingGrantCapacityError extends PairingGrantError {
  constructor() {
    super("Pairing grant capacity has been reached", "PAIRING_GRANT_CAPACITY_REACHED");
    this.name = "PairingGrantCapacityError";
  }
}

interface StoredPairingGrant extends PairingGrantRecord {
  credentialDigest: string;
  challengeNonceDigest: string;
}

/**
 * Process-local store for pairing grants.
 *
 * The store deliberately keeps only SHA-256 digests of the credential and
 * challenge nonce. A managed daemon restart creates a new instance identity,
 * so grants are not persisted across restarts. This keeps this phase small
 * and avoids turning a future persistent store into a second credential vault.
 *
 * JavaScript executes each public method synchronously, making the
 * check-and-consume transition atomic with respect to concurrent requests in
 * the daemon process. The eventual HTTP handler must call consume exactly once
 * for an exchange request and issue its steady-state credential only after it
 * returns successfully.
 */
export class PairingGrantStore {
  private readonly now: () => number;
  private readonly maxGrants: number;
  private readonly defaultTtlMs: number;
  private readonly allowedScopes: ReadonlySet<PairingScope>;
  private readonly recordsById = new Map<string, StoredPairingGrant>();
  private readonly idsByCredentialDigest = new Map<string, string>();

  constructor(options: PairingGrantStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxGrants = validateCapacity(options.maxGrants ?? DEFAULT_PAIRING_GRANT_CAPACITY);
    this.defaultTtlMs = validateTtl(
      options.defaultTtlMs ?? DEFAULT_PAIRING_GRANT_TTL_MS,
      "default pairing grant TTL",
    );
    this.allowedScopes = new Set(
      normalizeScopes(options.allowedScopes ?? DEFAULT_PAIRING_ALLOWED_SCOPES),
    );
  }

  /** Issue a fresh grant and challenge for one daemon instance. */
  issue(input: PairingGrantIssueInput): IssuedPairingGrant {
    const context = validateContext(input);
    const scopes = normalizeScopes(input.scopes ?? DEFAULT_PAIRING_SCOPES, this.allowedScopes);
    const subject = normalizeLabel(input.subject ?? "hosted-console", "subject");
    const label = input.label === undefined ? undefined : normalizeLabel(input.label, "label");
    const ttlMs = validateTtl(input.ttlMs ?? this.defaultTtlMs, "pairing grant TTL");
    const now = this.currentTime();

    this.expirePending(now);
    this.evictTerminalRecords();
    if (this.recordsById.size >= this.maxGrants) {
      throw new PairingGrantCapacityError();
    }

    const id = randomUUID();
    const credential = randomBytes(PAIRING_GRANT_SECRET_BYTES).toString("base64url");
    const challengeId = randomUUID();
    const nonce = randomBytes(PAIRING_CHALLENGE_NONCE_BYTES).toString("base64url");
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const challenge: PairingChallenge = {
      id: challengeId,
      nonce,
      issuedAt: createdAt,
      expiresAt,
    };
    const record: StoredPairingGrant = {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      ...context,
      id,
      scopes,
      subject,
      ...(label === undefined ? {} : { label }),
      challengeId,
      createdAt,
      expiresAt,
      state: "pending",
      credentialDigest: digestSecret(credential),
      challengeNonceDigest: digestSecret(nonce),
    };

    this.recordsById.set(id, record);
    this.idsByCredentialDigest.set(record.credentialDigest, id);

    return {
      ...toPublicRecord(record),
      credential,
      challenge,
    };
  }

  /**
   * Atomically consume a valid grant. Wrong context or challenge leaves the
   * grant pending so a legitimate browser can retry without minting a second
   * grant. A valid call transitions pending -> consumed exactly once.
   */
  consume(input: PairingGrantExchangeInput): ConsumedPairingGrant {
    const context = validateContext(input);
    const credential = normalizeSecret(input.credential, "pairing grant");
    const challengeId = normalizeSecret(input.challengeId, "pairing challenge id");
    const nonce = normalizeSecret(input.nonce, "pairing challenge nonce");
    const now = this.currentTime();
    this.expirePending(now);

    const id = this.idsByCredentialDigest.get(digestSecret(credential));
    const record = id === undefined ? undefined : this.recordsById.get(id);
    // Do not reveal whether a credential exists in another profile/instance.
    if (!record || !sameContext(record, context)) {
      throw new PairingGrantNotFoundError();
    }

    switch (record.state) {
      case "expired":
        throw new PairingGrantExpiredError();
      case "revoked":
        throw new PairingGrantRevokedError();
      case "consumed":
        throw new PairingGrantConsumedError();
      case "pending":
        break;
    }

    if (
      record.challengeId !== challengeId ||
      record.challengeNonceDigest !== digestSecret(nonce)
    ) {
      throw new PairingChallengeMismatchError();
    }

    const consumedAt = new Date(now).toISOString();
    record.state = "consumed";
    record.consumedAt = consumedAt;
    return {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      profileId: record.profileId,
      instanceId: record.instanceId,
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      grantId: record.id,
      scopes: [...record.scopes],
      subject: record.subject,
      ...(record.label === undefined ? {} : { label: record.label }),
      expiresAt: record.expiresAt,
      consumedAt,
    };
  }

  /** Return metadata for one profile without exposing credential material. */
  get(id: string, context: PairingGrantContext): PairingGrantRecord | null {
    const normalizedId = normalizeSecret(id, "pairing grant id");
    const normalizedContext = validateContext(context);
    this.expirePending(this.currentTime());
    const record = this.recordsById.get(normalizedId);
    return record && sameContext(record, normalizedContext) ? toPublicRecord(record) : null;
  }

  /** List metadata, newest first, with inactive records opt-in. */
  list(
    context: PairingGrantContext,
    options: PairingGrantListOptions = {},
  ): PairingGrantRecord[] {
    const normalizedContext = validateContext(context);
    this.expirePending(this.currentTime());
    return Array.from(this.recordsById.values())
      .filter(
        (record) =>
          sameContext(record, normalizedContext) &&
          (options.includeInactive === true || record.state === "pending"),
      )
      .sort(compareNewest)
      .map(toPublicRecord);
  }

  /** Revoke a pending grant. Repeated or terminal revocation is idempotent. */
  revoke(id: string, context: PairingGrantContext): boolean {
    const normalizedId = normalizeSecret(id, "pairing grant id");
    const normalizedContext = validateContext(context);
    this.expirePending(this.currentTime());
    const record = this.recordsById.get(normalizedId);
    if (!record || !sameContext(record, normalizedContext) || record.state !== "pending") {
      return false;
    }

    record.state = "revoked";
    record.revokedAt = new Date(this.currentTime()).toISOString();
    return true;
  }

  /** Mark elapsed pending grants as expired and return the number changed. */
  expire(): number {
    return this.expirePending(this.currentTime());
  }

  get size(): number {
    return this.recordsById.size;
  }

  private currentTime(): number {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new PairingGrantInputError("Pairing grant clock returned an invalid timestamp");
    }
    return now;
  }

  private expirePending(now: number): number {
    let expired = 0;
    for (const record of this.recordsById.values()) {
      if (record.state !== "pending" || Date.parse(record.expiresAt) > now) continue;
      record.state = "expired";
      record.expiredAt = new Date(now).toISOString();
      expired += 1;
    }
    return expired;
  }

  private evictTerminalRecords(): void {
    if (this.recordsById.size < this.maxGrants) return;

    const terminal = Array.from(this.recordsById.values())
      .filter((record) => record.state !== "pending")
      .sort(compareOldest);
    for (const record of terminal) {
      if (this.recordsById.size < this.maxGrants) break;
      this.recordsById.delete(record.id);
      this.idsByCredentialDigest.delete(record.credentialDigest);
    }
  }
}

export const PairingScopeSchema = z.enum(PAIRING_SCOPES);
export const PairingGrantStateSchema = z.enum(PAIRING_GRANT_STATES);
export const PairingGrantContextSchema = z
  .object({
    profileId: z.string().min(1).max(256),
    instanceId: z.string().min(1).max(256),
    workspaceId: z.string().regex(/^[a-z0-9-]{1,256}$/i).optional(),
  })
  .strict();

export const PairingChallengeSchema = z
  .object({
    id: z.string().uuid(),
    nonce: z.string().min(1).max(256),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const PairingGrantRecordSchema = z
  .object({
    protocolVersion: z.literal(PAIRING_PROTOCOL_VERSION),
    profileId: z.string().min(1).max(256),
    instanceId: z.string().min(1).max(256),
    workspaceId: z.string().regex(/^[a-z0-9-]{1,256}$/i).optional(),
    id: z.string().uuid(),
    scopes: z.array(PairingScopeSchema).min(1),
    subject: z.string().min(1).max(256),
    label: z.string().min(1).max(256).optional(),
    challengeId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    state: PairingGrantStateSchema,
    consumedAt: z.string().datetime({ offset: true }).optional(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
    expiredAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const IssuedPairingGrantSchema = PairingGrantRecordSchema.extend({
  credential: z.string().min(1).max(256),
  challenge: PairingChallengeSchema,
}).strict();

export const PairingGrantIssueRequestSchema = z
  .object({
    protocolVersion: z.literal(PAIRING_PROTOCOL_VERSION),
    scopes: z.array(PairingScopeSchema).min(1).max(PAIRING_SCOPES.length).optional(),
    subject: z.string().min(1).max(256).optional(),
    label: z.string().min(1).max(256).optional(),
    ttlMs: z
      .number()
      .int()
      .min(MIN_PAIRING_GRANT_TTL_MS)
      .max(MAX_PAIRING_GRANT_TTL_MS)
      .optional(),
    workspaceId: z.string().regex(/^[a-z0-9-]{1,256}$/i).optional(),
  })
  .strict();

export const PairingGrantExchangeRequestSchema = z
  .object({
    protocolVersion: z.literal(PAIRING_PROTOCOL_VERSION),
    grant: z.string().min(1).max(256),
    challengeId: z.string().uuid(),
    nonce: z.string().min(1).max(256),
    workspaceId: z.string().regex(/^[a-z0-9-]{1,256}$/i).optional(),
  })
  .strict();

export const PairingGrantExchangeResponseSchema = z
  .object({
    accepted: z.literal(true),
    protocolVersion: z.literal(PAIRING_PROTOCOL_VERSION),
    profileId: z.string().min(1).max(256),
    instanceId: z.string().min(1).max(256),
    workspaceId: z.string().regex(/^[a-z0-9-]{1,256}$/i).optional(),
    grantId: z.string().uuid(),
    scopes: z.array(PairingScopeSchema).min(1),
    subject: z.string().min(1).max(256),
    label: z.string().min(1).max(256).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    consumedAt: z.string().datetime({ offset: true }),
    management: z
      .object({
        token: z.string().min(1).max(256),
        expiresAt: z.string().datetime({ offset: true }),
        scope: z.literal(MANAGEMENT_CREDENTIAL_SCOPE),
        authority: z.enum(["workspace", "host"]),
        workspaceId: z.string().regex(/^[a-z0-9-]{1,256}$/i).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function validateContext(input: PairingGrantContext): PairingGrantContext {
  if (!input || typeof input !== "object") {
    throw new PairingGrantInputError("Pairing grant profile and instance are required");
  }
  const workspaceId = input.workspaceId;
  if (workspaceId !== undefined && !/^[a-z0-9-]{1,256}$/i.test(workspaceId)) {
    throw new PairingGrantInputError("Pairing workspace ID is invalid");
  }
  return {
    profileId: normalizeLabel(input.profileId, "profile id"),
    instanceId: normalizeLabel(input.instanceId, "instance id"),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function normalizeScopes(
  scopes: readonly PairingScope[],
  allowedScopes?: ReadonlySet<PairingScope>,
): readonly PairingScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new PairingGrantInputError("At least one pairing scope is required");
  }
  const unique = new Set<string>();
  for (const scope of scopes) {
    if (!PAIRING_SCOPES.includes(scope)) {
      throw new PairingGrantInputError(`Unsupported pairing scope: ${String(scope)}`);
    }
    if (allowedScopes && !allowedScopes.has(scope)) {
      throw new PairingGrantInputError(`Pairing scope is not enabled: ${scope}`);
    }
    if (unique.has(scope)) {
      throw new PairingGrantInputError(`Duplicate pairing scope: ${scope}`);
    }
    unique.add(scope);
  }
  return scopes.slice();
}

function normalizeLabel(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new PairingGrantInputError(`Pairing ${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new PairingGrantInputError(`Pairing ${field} must contain 1-256 characters`);
  }
  if (/[\[\]{}<>\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PairingGrantInputError(`Pairing ${field} contains unsupported characters`);
  }
  return normalized;
}

function normalizeSecret(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new PairingGrantInputError(`Pairing ${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new PairingGrantInputError(`Pairing ${field} must contain 1-256 characters`);
  }
  return normalized;
}

function validateTtl(value: number, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_PAIRING_GRANT_TTL_MS ||
    value > MAX_PAIRING_GRANT_TTL_MS
  ) {
    throw new PairingGrantInputError(
      `${field} must be an integer between ${MIN_PAIRING_GRANT_TTL_MS} and ${MAX_PAIRING_GRANT_TTL_MS} milliseconds`,
    );
  }
  return value;
}

function validateCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new PairingGrantInputError("Pairing grant capacity must be an integer between 1 and 10000");
  }
  return value;
}

function digestSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function sameContext(left: PairingGrantContext, right: PairingGrantContext): boolean {
  return (
    left.profileId === right.profileId &&
    left.instanceId === right.instanceId &&
    left.workspaceId === right.workspaceId
  );
}

function toPublicRecord(record: StoredPairingGrant): PairingGrantRecord {
  return {
    protocolVersion: PAIRING_PROTOCOL_VERSION,
    profileId: record.profileId,
    instanceId: record.instanceId,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    id: record.id,
    scopes: [...record.scopes],
    subject: record.subject,
    ...(record.label === undefined ? {} : { label: record.label }),
    challengeId: record.challengeId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state,
    ...(record.consumedAt === undefined ? {} : { consumedAt: record.consumedAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt }),
  };
}

function compareNewest(left: PairingGrantRecord, right: PairingGrantRecord): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  return byCreatedAt !== 0 ? byCreatedAt : right.id.localeCompare(left.id);
}

function compareOldest(left: PairingGrantRecord, right: PairingGrantRecord): number {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
}
