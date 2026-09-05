import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The control-plane handoff is intentionally short-lived. */
export const DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS = 5 * 60 * 1_000;
/** Callers cannot accidentally turn a browser handoff into a long-lived key. */
export const MAX_MANAGEMENT_CREDENTIAL_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_MANAGEMENT_CREDENTIALS = 8;
export const MANAGEMENT_CREDENTIAL_SCOPE = "management" as const;
export const MANAGEMENT_CREDENTIAL_HANDOFF_PATH = "/api/v1/management/handoff" as const;

export interface ManagementCredentialGrant {
  token: string;
  expiresAt: string;
  scope: typeof MANAGEMENT_CREDENTIAL_SCOPE;
  /** Workspace selected by the local CLI handoff, when available. */
  workspaceId?: string;
}

export interface ManagementCredentialStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxCredentials?: number;
  generateToken?: () => string;
  workspaceId?: string;
}

interface CredentialRecord {
  digest: Uint8Array;
  expiresAtMs: number;
  issuedAtMs: number;
}

/**
 * Holds browser-facing control-plane credentials only in daemon memory.
 *
 * The long-lived local daemon token never enters this store. A grant is a
 * scoped, expiring bearer credential intended for a hosted console handoff;
 * restarting the daemon drops every grant. Only token digests are retained so
 * an in-process state dump cannot recover an active handoff value.
 */
export class ManagementCredentialStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxCredentials: number;
  private readonly generateToken: () => string;
  private readonly workspaceId: string | undefined;
  private readonly credentials = new Map<string, CredentialRecord>();

  constructor(options: ManagementCredentialStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = validateTtl(options.ttlMs ?? DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS);
    this.maxCredentials = validateMaxCredentials(
      options.maxCredentials ?? DEFAULT_MAX_MANAGEMENT_CREDENTIALS,
    );
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
    this.workspaceId = validateWorkspaceId(options.workspaceId);
  }

  /** Issue a fresh management grant without persisting it to disk. */
  issue(): ManagementCredentialGrant {
    const issuedAtMs = this.now();
    this.prune(issuedAtMs);

    let token = this.generateToken();
    let digest = digestToken(token);
    while (this.credentials.has(digestKey(digest))) {
      token = this.generateToken();
      digest = digestToken(token);
    }

    while (this.credentials.size >= this.maxCredentials) {
      this.removeOldest();
    }

    const expiresAtMs = issuedAtMs + this.ttlMs;
    this.credentials.set(digestKey(digest), {
      digest,
      expiresAtMs,
      issuedAtMs,
    });

    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      scope: MANAGEMENT_CREDENTIAL_SCOPE,
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
    };
  }

  /** Validate a grant without consuming it; the hosted console may poll. */
  authorize(token: string | undefined): boolean {
    if (!token) return false;

    const nowMs = this.now();
    this.prune(nowMs);
    const candidate = digestToken(token);

    for (const record of this.credentials.values()) {
      if (record.expiresAtMs <= nowMs) continue;
      if (record.digest.length !== candidate.length) continue;
      if (timingSafeEqual(record.digest, candidate)) return true;
    }

    return false;
  }

  /** Revoke one grant when a console session is explicitly closed. */
  revoke(token: string | undefined): boolean {
    if (!token) return false;
    return this.credentials.delete(digestKey(digestToken(token)));
  }

  /** Drop all browser credentials when the daemon is shutting down. */
  clear(): void {
    this.credentials.clear();
  }

  get size(): number {
    this.prune(this.now());
    return this.credentials.size;
  }

  private prune(nowMs: number): void {
    for (const [key, record] of this.credentials) {
      if (record.expiresAtMs <= nowMs) this.credentials.delete(key);
    }
  }

  private removeOldest(): void {
    let oldestKey: string | undefined;
    let oldestIssuedAt = Number.POSITIVE_INFINITY;

    for (const [key, record] of this.credentials) {
      if (record.issuedAtMs < oldestIssuedAt) {
        oldestIssuedAt = record.issuedAtMs;
        oldestKey = key;
      }
    }

    if (oldestKey) this.credentials.delete(oldestKey);
  }
}

function digestToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

function digestKey(digest: Uint8Array): string {
  return Buffer.from(digest).toString("hex");
}

function validateTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MANAGEMENT_CREDENTIAL_TTL_MS) {
    throw new RangeError(
      `Management credential TTL must be a positive integer no greater than ${MAX_MANAGEMENT_CREDENTIAL_TTL_MS}ms`,
    );
  }
  return value;
}

function validateMaxCredentials(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Maximum management credentials must be a positive integer");
  }
  return value;
}

function validateWorkspaceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-z0-9-]{1,256}$/i.test(value)) {
    throw new RangeError("Management credential workspace ID is invalid");
  }
  return value;
}
