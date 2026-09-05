import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ManagementCredentialGrant, ManagementCredentialStore } from "./management-credentials.js";
import { CONTROL_PLANE_PATH } from "./paths.js";

/** Version of the browser-to-local-daemon management exchange. */
export const BROWSER_MANAGEMENT_PROTOCOL_VERSION = "1" as const;
export const DEFAULT_BROWSER_CHALLENGE_TTL_MS = 60_000;
export const MAX_BROWSER_CHALLENGE_TTL_MS = 5 * 60_000;
export const DEFAULT_BROWSER_DEVICE_CAPACITY = 16;
export const MAX_BROWSER_DEVICE_CAPACITY = 256;
export const DEFAULT_BROWSER_CHALLENGE_CAPACITY = 32;
export const CONTROL_PLANE_BROWSER_DEVICES_PATH = `${CONTROL_PLANE_PATH}/management/browser-devices` as const;
export const CONTROL_PLANE_BROWSER_CHALLENGE_PATH = `${CONTROL_PLANE_PATH}/management/browser-challenge` as const;
export const CONTROL_PLANE_BROWSER_EXCHANGE_PATH = `${CONTROL_PLANE_PATH}/management/browser-exchange` as const;

/** The daemon stores this reduced JWK, never a browser private key. */
export interface BrowserDevicePublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface BrowserDeviceRecord {
  id: string;
  publicKeyFingerprint: string;
  label?: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface BrowserDeviceRegistration {
  deviceId?: string;
  publicKey: unknown;
  label?: string;
}

export interface BrowserManagementChallenge {
  protocolVersion: typeof BROWSER_MANAGEMENT_PROTOCOL_VERSION;
  challengeId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  instanceId: string;
}

export interface BrowserManagementExchange {
  protocolVersion?: typeof BROWSER_MANAGEMENT_PROTOCOL_VERSION;
  deviceId: string;
  challengeId: string;
  signature: string;
}

export interface BrowserManagementExchangeResult {
  grant: ManagementCredentialGrant;
  device: BrowserDeviceRecord;
}

export interface BrowserManagementSessionStoreOptions {
  /** Optional persistent path. Only public keys and metadata are written. */
  path?: string;
  instanceId: string;
  now?: () => number;
  challengeTtlMs?: number;
  maxDevices?: number;
  maxChallenges?: number;
}

interface StoredBrowserDevice extends BrowserDeviceRecord {
  publicKey: BrowserDevicePublicKey;
}

interface BrowserDeviceDocument {
  schemaVersion: 1;
  devices: StoredBrowserDevice[];
}

interface PendingChallenge extends BrowserManagementChallenge {
  attempts: number;
  consumed: boolean;
}

/**
 * Process-safe browser management enrollment and challenge exchange.
 *
 * Enrollment is authenticated by a currently valid management/root credential
 * in the HTTP transport. The subsequent challenge exchange is unauthenticated
 * at HTTP level, but requires an Ed25519 signature from a previously enrolled
 * browser key. The returned bearer is always a fresh, short-lived management
 * credential; this store never handles or persists the daemon root token.
 */
export class BrowserManagementSessionStore {
  private readonly path: string | undefined;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly challengeTtlMs: number;
  private readonly maxDevices: number;
  private readonly maxChallenges: number;
  private readonly devices = new Map<string, StoredBrowserDevice>();
  private readonly challenges = new Map<string, PendingChallenge>();
  private initialized = false;

  constructor(options: BrowserManagementSessionStoreOptions) {
    if (!options || typeof options.instanceId !== "string" || options.instanceId.length === 0) {
      throw new RangeError("Browser management instance ID is required");
    }
    this.instanceId = options.instanceId;
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.challengeTtlMs = validateChallengeTtl(options.challengeTtlMs ?? DEFAULT_BROWSER_CHALLENGE_TTL_MS);
    this.maxDevices = validateCapacity(
      options.maxDevices ?? DEFAULT_BROWSER_DEVICE_CAPACITY,
      MAX_BROWSER_DEVICE_CAPACITY,
      "browser device capacity",
    );
    this.maxChallenges = validateCapacity(
      options.maxChallenges ?? DEFAULT_BROWSER_CHALLENGE_CAPACITY,
      1_000,
      "browser challenge capacity",
    );
  }

  /** Load the public-key registry. Missing storage starts with an empty registry. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.path) return;
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Browser management device registry is invalid JSON");
    }
    if (!isBrowserDeviceDocument(parsed)) {
      throw new Error("Browser management device registry has an unsupported format");
    }
    if (parsed.devices.length > this.maxDevices) {
      throw new Error("Browser management device registry exceeds its capacity");
    }
    await chmod(this.path, 0o600).catch(() => undefined);
    for (const device of parsed.devices) {
      const normalized = normalizeStoredDevice(device);
      if (this.devices.has(normalized.id)) {
        throw new Error("Browser management device registry contains duplicate IDs");
      }
      this.devices.set(normalized.id, normalized);
    }
  }

  /** Return active device metadata; public keys are intentionally omitted. */
  list(options: { includeRevoked?: boolean } = {}): BrowserDeviceRecord[] {
    return Array.from(this.devices.values())
      .filter((device) => options.includeRevoked === true || device.revokedAt === undefined)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map(toPublicDevice);
  }

  get(deviceId: string): BrowserDeviceRecord | null {
    const device = this.devices.get(normalizeDeviceId(deviceId));
    return device ? toPublicDevice(device) : null;
  }

  /** Add a key or update metadata for the same key/device ID. */
  async register(input: BrowserDeviceRegistration): Promise<BrowserDeviceRecord> {
    const publicKey = normalizePublicKey(input.publicKey);
    const label = input.label === undefined ? undefined : normalizeLabel(input.label);
    const now = new Date(this.currentTime()).toISOString();
    const requestedId = input.deviceId === undefined ? undefined : normalizeDeviceId(input.deviceId);

    if (requestedId) {
      const existing = this.devices.get(requestedId);
      if (!existing) throw new BrowserManagementError("Browser device was not found", "DEVICE_NOT_FOUND");
      if (existing.revokedAt !== undefined) {
        throw new BrowserManagementError("Browser device has been revoked", "DEVICE_REVOKED");
      }
      if (existing.publicKey.x !== publicKey.x) {
        throw new BrowserManagementError(
          "Browser device public key does not match the enrolled device",
          "DEVICE_KEY_MISMATCH",
        );
      }
      existing.label = label;
      existing.lastSeenAt = now;
      await this.persist();
      return toPublicDevice(existing);
    }

    this.pruneRevoked();
    if (this.devices.size >= this.maxDevices) {
      throw new BrowserManagementError("Browser device capacity has been reached", "DEVICE_CAPACITY");
    }
    const device: StoredBrowserDevice = {
      id: randomUUID(),
      publicKey,
      publicKeyFingerprint: fingerprintPublicKey(publicKey),
      ...(label === undefined ? {} : { label }),
      createdAt: now,
      lastSeenAt: now,
    };
    this.devices.set(device.id, device);
    await this.persist();
    return toPublicDevice(device);
  }

  /** Remove a device and its public key. Removal is intentionally idempotent. */
  async revoke(deviceId: string): Promise<boolean> {
    const id = normalizeDeviceId(deviceId);
    const removed = this.devices.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  /** Issue a short-lived nonce. No management credential is created here. */
  issueChallenge(): BrowserManagementChallenge {
    const now = this.currentTime();
    this.pruneChallenges();
    while (this.challenges.size >= this.maxChallenges) {
      const oldest = this.challenges.keys().next().value as string | undefined;
      if (!oldest) break;
      this.challenges.delete(oldest);
    }
    const issuedAt = new Date(now).toISOString();
    const challenge: PendingChallenge = {
      protocolVersion: BROWSER_MANAGEMENT_PROTOCOL_VERSION,
      challengeId: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      issuedAt,
      expiresAt: new Date(now + this.challengeTtlMs).toISOString(),
      instanceId: this.instanceId,
      attempts: 0,
      consumed: false,
    };
    this.challenges.set(challenge.challengeId, challenge);
    return toPublicChallenge(challenge);
  }

  /** Verify one signature and mint a fresh host-scoped management credential. */
  async exchange(
    input: BrowserManagementExchange,
    credentials: ManagementCredentialStore,
  ): Promise<BrowserManagementExchangeResult> {
    if (input.protocolVersion !== undefined && input.protocolVersion !== BROWSER_MANAGEMENT_PROTOCOL_VERSION) {
      throw new BrowserManagementError("Unsupported browser management protocol", "PROTOCOL_UNSUPPORTED");
    }
    const challengeId = normalizeChallengeId(input.challengeId);
    const deviceId = normalizeDeviceId(input.deviceId);
    const signature = normalizeSignature(input.signature);
    const now = this.currentTime();
    this.pruneChallenges();
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.consumed) {
      throw new BrowserManagementError("Browser management challenge was not found", "CHALLENGE_NOT_FOUND");
    }
    if (Date.parse(challenge.expiresAt) <= now) {
      challenge.consumed = true;
      throw new BrowserManagementError("Browser management challenge has expired", "CHALLENGE_EXPIRED");
    }
    if (challenge.instanceId !== this.instanceId) {
      throw new BrowserManagementError("Browser management challenge is not valid for this daemon", "CHALLENGE_CONTEXT");
    }

    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt !== undefined) {
      throw new BrowserManagementError("Browser device was not found", "DEVICE_NOT_FOUND");
    }
    challenge.attempts += 1;
    if (challenge.attempts > 5) {
      challenge.consumed = true;
      throw new BrowserManagementError("Browser management challenge has too many attempts", "CHALLENGE_ATTEMPTS");
    }

    if (!verifyBrowserSignature(challenge, device.publicKey, signature)) {
      throw new BrowserManagementError("Browser management signature is invalid", "SIGNATURE_INVALID");
    }
    challenge.consumed = true;
    device.lastSeenAt = new Date(now).toISOString();
    await this.persist();
    const grant = credentials.issue();
    if (grant.authority !== "host" || grant.scope !== "management") {
      credentials.revoke(grant.token);
      throw new BrowserManagementError(
        "Browser management credentials must be host-scoped management grants",
        "CREDENTIAL_SCOPE_INVALID",
      );
    }
    return { grant, device: toPublicDevice(device) };
  }

  get size(): number {
    return this.devices.size;
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new BrowserManagementError("Browser management clock is invalid", "CLOCK_INVALID");
    return value;
  }

  private pruneChallenges(): void {
    for (const [id, challenge] of this.challenges) {
      // Retain expired entries until the bounded challenge map needs space so
      // callers receive an explicit expiry result instead of an ambiguous
      // not-found response. Consumed challenges are removed immediately and
      // can never be replayed.
      if (challenge.consumed) this.challenges.delete(id);
    }
  }

  private pruneRevoked(): void {
    for (const [id, device] of this.devices) {
      if (device.revokedAt !== undefined) this.devices.delete(id);
    }
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const document: BrowserDeviceDocument = {
      schemaVersion: 1,
      devices: Array.from(this.devices.values()),
    };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export class BrowserManagementError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BrowserManagementError";
  }
}

/** Canonical bytes that the Web Crypto Ed25519 private key must sign. */
export function browserChallengeSigningPayload(challenge: BrowserManagementChallenge): Uint8Array {
  return new TextEncoder().encode(
    `${BROWSER_MANAGEMENT_PROTOCOL_VERSION}\nroutermcp-browser-management\n${challenge.instanceId}\n${challenge.challengeId}\n${challenge.nonce}\n${challenge.expiresAt}`,
  );
}

export function fingerprintPublicKey(publicKey: BrowserDevicePublicKey): string {
  return createHash("sha256")
    .update(`Ed25519:${publicKey.x}`, "utf8")
    .digest("base64url");
}

function verifyBrowserSignature(
  challenge: BrowserManagementChallenge,
  publicKey: BrowserDevicePublicKey,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
      format: "jwk",
    });
    return verify(null, browserChallengeSigningPayload(challenge), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function normalizePublicKey(value: unknown): BrowserDevicePublicKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserManagementError("Browser public key must be an Ed25519 JWK", "KEY_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (record.kty !== "OKP" || record.crv !== "Ed25519" || typeof record.x !== "string") {
    throw new BrowserManagementError("Browser public key must be an Ed25519 JWK", "KEY_INVALID");
  }
  if ("d" in record || !/^[A-Za-z0-9_-]{43}$/.test(record.x)) {
    throw new BrowserManagementError("Browser public key must contain only the Ed25519 public key", "KEY_INVALID");
  }
  return { kty: "OKP", crv: "Ed25519", x: record.x };
}

function normalizeStoredDevice(device: StoredBrowserDevice): StoredBrowserDevice {
  const publicKey = normalizePublicKey(device.publicKey);
  const id = normalizeDeviceId(device.id);
  const createdAt = normalizeTimestamp(device.createdAt, "createdAt");
  const lastSeenAt = normalizeTimestamp(device.lastSeenAt, "lastSeenAt");
  const label = device.label === undefined ? undefined : normalizeLabel(device.label);
  const revokedAt = device.revokedAt === undefined ? undefined : normalizeTimestamp(device.revokedAt, "revokedAt");
  return {
    id,
    publicKey,
    publicKeyFingerprint: fingerprintPublicKey(publicKey),
    ...(label === undefined ? {} : { label }),
    createdAt,
    lastSeenAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function toPublicDevice(device: StoredBrowserDevice): BrowserDeviceRecord {
  return {
    id: device.id,
    publicKeyFingerprint: device.publicKeyFingerprint,
    ...(device.label === undefined ? {} : { label: device.label }),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  };
}

function toPublicChallenge(challenge: PendingChallenge): BrowserManagementChallenge {
  return {
    protocolVersion: challenge.protocolVersion,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    instanceId: challenge.instanceId,
  };
}

function isBrowserDeviceDocument(value: unknown): value is BrowserDeviceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && Array.isArray(record.devices);
}

function normalizeDeviceId(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BrowserManagementError("Browser device ID is invalid", "DEVICE_ID_INVALID");
  }
  return value;
}

function normalizeChallengeId(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BrowserManagementError("Browser challenge ID is invalid", "CHALLENGE_ID_INVALID");
  }
  return value;
}

function normalizeSignature(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) {
    throw new BrowserManagementError("Browser signature is invalid", "SIGNATURE_INVALID");
  }
  return value;
}

function normalizeLabel(value: string): string {
  if (typeof value !== "string") throw new BrowserManagementError("Browser device label is invalid", "LABEL_INVALID");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256 || /[\[\]{}<>\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BrowserManagementError("Browser device label is invalid", "LABEL_INVALID");
  }
  return normalized;
}

function normalizeTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new BrowserManagementError(`Browser device ${field} is invalid`, "REGISTRY_INVALID");
  }
  return new Date(Date.parse(value)).toISOString();
}

function validateChallengeTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BROWSER_CHALLENGE_TTL_MS) {
    throw new RangeError(`Browser challenge TTL must be a positive integer no greater than ${MAX_BROWSER_CHALLENGE_TTL_MS}ms`);
  }
  return value;
}

function validateCapacity(value: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}
