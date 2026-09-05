import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The control-plane handoff is intentionally short-lived. */
export const DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS = 5 * 60 * 1_000;
/** Callers cannot accidentally turn a browser handoff into a long-lived key. */
export const MAX_MANAGEMENT_CREDENTIAL_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_MANAGEMENT_CREDENTIALS = 8;
export const MANAGEMENT_CREDENTIAL_SCOPE = "management" as const;
export const MANAGEMENT_CREDENTIAL_HANDOFF_PATH = "/api/v1/management/handoff" as const;

/**
 * Authority carried by a short-lived browser handoff.
 *
 * A workspace grant can inspect and mutate only its claimed workspace. A host
 * grant is issued by the user-scoped daemon host and can select any workspace
 * already registered with that host. Keeping this separate from `scope`
 * leaves room for the future peering scopes without widening management
 * credentials accidentally.
 */
export const MANAGEMENT_CREDENTIAL_AUTHORITIES = ["workspace", "host"] as const;
export type ManagementCredentialAuthority = (typeof MANAGEMENT_CREDENTIAL_AUTHORITIES)[number];

export interface ManagementCredentialGrant {
  token: string;
  expiresAt: string;
  scope: typeof MANAGEMENT_CREDENTIAL_SCOPE;
  authority: ManagementCredentialAuthority;
  /** Workspace selected by the local CLI handoff, when available. */
  workspaceId?: string;
}

/** Sanitized authorization details used by the HTTP transport for scope checks. */
export interface ManagementCredentialAuthorization {
  authority: ManagementCredentialAuthority;
  workspaceId?: string;
}

export interface ManagementCredentialStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxCredentials?: number;
  generateToken?: () => string;
  /** Workspace claim attached to every grant issued by this store. */
  workspaceId?: string;
  /**
   * Authority attached to new grants. Stores bound to one workspace default
   * to workspace authority for backwards compatibility; a host store must
   * opt into host authority explicitly, even when it includes an initial
   * workspace selection in the grant.
   */
  authority?: ManagementCredentialAuthority;
  /** Additional workspace claims that a trusted local handoff may request. */
  allowedWorkspaceIds?: readonly string[];
  /** Dynamic registry gate for claims that may be issued by this store. */
  canIssueWorkspace?: (workspaceId: string) => boolean;
}

interface CredentialRecord {
  digest: Uint8Array;
  expiresAtMs: number;
  issuedAtMs: number;
  authority: ManagementCredentialAuthority;
  workspaceId?: string;
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
  private readonly authority: ManagementCredentialAuthority;
  private readonly allowedWorkspaceIds: Set<string>;
  private readonly canIssueWorkspace: ((workspaceId: string) => boolean) | undefined;
  private readonly credentials = new Map<string, CredentialRecord>();

  constructor(options: ManagementCredentialStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = validateTtl(options.ttlMs ?? DEFAULT_MANAGEMENT_CREDENTIAL_TTL_MS);
    this.maxCredentials = validateMaxCredentials(
      options.maxCredentials ?? DEFAULT_MAX_MANAGEMENT_CREDENTIALS,
    );
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
    this.workspaceId = validateWorkspaceId(options.workspaceId);
    this.authority = options.authority ?? (this.workspaceId ? "workspace" : "host");
    this.allowedWorkspaceIds = new Set(
      (options.allowedWorkspaceIds ?? []).map((workspaceId) => validateRequiredWorkspaceId(workspaceId)),
    );
    if (this.workspaceId) this.allowedWorkspaceIds.add(this.workspaceId);
    this.canIssueWorkspace = options.canIssueWorkspace;
  }

  /** Workspace claim attached to grants issued by this store, if any. */
  get claimedWorkspaceId(): string | undefined {
    return this.workspaceId;
  }

  /**
   * Issue a fresh management grant without persisting it to disk.
   *
   * A requested workspace claim is accepted only when it is the store's
   * default claim or has been explicitly allowed by the host. The callback is
   * intended for a live workspace registry; the static allowlist is useful
   * for embedders and deterministic tests. An unscoped store cannot mint a
   * scoped grant unless the caller opts into one of those gates.
   */
  issue(workspaceId?: string): ManagementCredentialGrant {
    const claim = workspaceId === undefined ? this.workspaceId : validateRequiredWorkspaceId(workspaceId);
    if (this.authority === "workspace" && claim === undefined) {
      throw new RangeError("Workspace management credentials require a workspace claim");
    }
    if (claim !== undefined && !this.canIssueClaim(claim)) {
      throw new RangeError("Management credential workspace claim is not allowed");
    }

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
      authority: this.authority,
      ...(claim ? { workspaceId: claim } : {}),
    });

    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      scope: MANAGEMENT_CREDENTIAL_SCOPE,
      authority: this.authority,
      ...(claim ? { workspaceId: claim } : {}),
    };
  }

  /** Return whether a workspace claim may be requested for a new grant. */
  canIssueForWorkspace(workspaceId: string | undefined): boolean {
    if (workspaceId === undefined) {
      return this.workspaceId === undefined || this.canIssueClaim(this.workspaceId);
    }
    if (!isValidWorkspaceId(workspaceId)) return false;
    return this.canIssueClaim(workspaceId);
  }

  /** Validate a grant without consuming it; the hosted console may poll. */
  authorize(token: string | undefined, expectedWorkspaceId?: string): boolean {
    const authorization = this.getAuthorization(token);
    if (!authorization) return false;
    if (expectedWorkspaceId !== undefined && !isValidWorkspaceId(expectedWorkspaceId)) {
      return false;
    }
    return (
      authorization.authority === "host" ||
      expectedWorkspaceId === undefined ||
      authorization.workspaceId === expectedWorkspaceId
    );
  }

  /**
   * Resolve one active credential without exposing the token or digest.
   * Callers use the authority to distinguish host-wide browser handoffs from
   * legacy workspace-scoped grants before selecting a context.
   */
  getAuthorization(token: string | undefined): ManagementCredentialAuthorization | null {
    if (!token) return null;

    const nowMs = this.now();
    this.prune(nowMs);
    const candidate = digestToken(token);

    for (const record of this.credentials.values()) {
      if (record.expiresAtMs <= nowMs) continue;
      if (record.digest.length !== candidate.length) continue;
      if (timingSafeEqual(record.digest, candidate)) {
        return {
          authority: record.authority,
          ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
        };
      }
    }

    return null;
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

  private canIssueClaim(workspaceId: string): boolean {
    if (!this.allowedWorkspaceIds.has(workspaceId) && !this.canIssueWorkspace) return false;
    return this.canIssueWorkspace?.(workspaceId) ?? true;
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

/** Validate the bounded, path-safe workspace claim used by local management. */
export function isValidWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,256}$/i.test(value);
}

function validateRequiredWorkspaceId(value: string): string {
  if (!isValidWorkspaceId(value)) {
    throw new RangeError("Management credential workspace ID is invalid");
  }
  return value;
}

function validateWorkspaceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return validateRequiredWorkspaceId(value);
}
