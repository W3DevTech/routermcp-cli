import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isValidWorkspaceId, type ManagementCredentialAuthorization } from "./management-credentials.js";

export const WORKSPACE_MCP_CREDENTIALS_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAX_WORKSPACE_MCP_CREDENTIALS = 256;

export interface WorkspaceMcpCredentialStoreOptions {
  path: string;
  now?: () => number;
  maxCredentials?: number;
  generateToken?: () => string;
  canIssueWorkspace?: (workspaceId: string) => boolean;
}

export interface WorkspaceMcpCredentialResult {
  scope: "mcp";
  workspaceId: string;
  token?: string;
  configuredAt: string;
  rotatedAt?: string;
  created: boolean;
  rotated: boolean;
}

interface WorkspaceMcpCredentialRecord {
  workspaceId: string;
  digest: string;
  configuredAt: string;
  rotatedAt?: string;
}

interface WorkspaceMcpCredentialDocument {
  schemaVersion: typeof WORKSPACE_MCP_CREDENTIALS_SCHEMA_VERSION;
  updatedAt: string;
  credentials: WorkspaceMcpCredentialRecord[];
}

/**
 * Durable direct-MCP credentials for registered workspaces.
 *
 * Only SHA-256 digests are persisted. The clear token is returned once when a
 * credential is first created or explicitly rotated, then belongs in the MCP
 * client's own secret store. File permissions are restricted to the current
 * user and writes are atomic so a daemon restart cannot invalidate clients.
 */
export class WorkspaceMcpCredentialStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly maxCredentials: number;
  private readonly generateToken: () => string;
  private readonly canIssueWorkspace: ((workspaceId: string) => boolean) | undefined;
  private readonly credentials = new Map<string, WorkspaceMcpCredentialRecord>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceMcpCredentialStoreOptions) {
    this.path = resolve(options.path);
    this.now = options.now ?? Date.now;
    this.maxCredentials = validateMaxCredentials(
      options.maxCredentials ?? DEFAULT_MAX_WORKSPACE_MCP_CREDENTIALS,
    );
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
    this.canIssueWorkspace = options.canIssueWorkspace;
  }

  get credentialsPath(): string {
    return this.path;
  }

  async initialize(): Promise<void> {
    await this.ensureLoaded();
  }

  /** Return whether a workspace already has a durable credential. */
  has(workspaceId: string): boolean {
    return this.credentials.has(workspaceId);
  }

  canIssueForWorkspace(workspaceId: string): boolean {
    return isValidWorkspaceId(workspaceId) && (this.canIssueWorkspace?.(workspaceId) ?? true);
  }

  /**
   * Create a credential once, or rotate it when explicitly requested. An
   * existing credential never returns its token because only its digest is
   * recoverable after the first issuance.
   */
  async issue(
    workspaceId: string,
    options: { rotate?: boolean } = {},
  ): Promise<WorkspaceMcpCredentialResult> {
    validateWorkspaceId(workspaceId);
    if (!this.canIssueForWorkspace(workspaceId)) {
      throw new RangeError("Workspace MCP credential workspace is not available");
    }
    await this.ensureLoaded();

    return this.mutate(async () => {
      const existing = this.credentials.get(workspaceId);
      if (existing && options.rotate !== true) {
        return {
          scope: "mcp" as const,
          workspaceId,
          configuredAt: existing.configuredAt,
          ...(existing.rotatedAt ? { rotatedAt: existing.rotatedAt } : {}),
          created: false,
          rotated: false,
        };
      }

      const timestamp = nowIso(this.now);
      const token = this.uniqueToken();
      const record: WorkspaceMcpCredentialRecord = existing
        ? {
            ...existing,
            digest: digestToken(token),
            rotatedAt: timestamp,
          }
        : {
            workspaceId,
            digest: digestToken(token),
            configuredAt: timestamp,
          };

      this.credentials.set(workspaceId, record);
      this.trimRecords();
      await this.persist();
      return {
        scope: "mcp" as const,
        workspaceId,
        token,
        configuredAt: record.configuredAt,
        ...(record.rotatedAt ? { rotatedAt: record.rotatedAt } : {}),
        created: !existing,
        rotated: Boolean(existing),
      };
    });
  }

  /** Authorize a token only for the workspace encoded by its URL. */
  authorize(token: string | undefined, workspaceId: string): boolean {
    if (!token || !isValidWorkspaceId(workspaceId)) return false;
    const record = this.credentials.get(workspaceId);
    if (!record) return false;
    const candidate = Buffer.from(digestToken(token), "hex");
    const expected = Buffer.from(record.digest, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  /** Adapter-compatible authorization metadata without exposing secret data. */
  getAuthorization(token: string | undefined): ManagementCredentialAuthorization | null {
    if (!token) return null;
    const digest = digestToken(token);
    for (const record of this.credentials.values()) {
      const expected = Buffer.from(record.digest, "hex");
      const candidate = Buffer.from(digest, "hex");
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        return { authority: "workspace", workspaceId: record.workspaceId };
      }
    }
    return null;
  }

  /** Remove one workspace credential so its MCP client can no longer connect. */
  async revoke(workspaceId: string): Promise<boolean> {
    validateWorkspaceId(workspaceId);
    await this.ensureLoaded();
    return this.mutate(async () => {
      const removed = this.credentials.delete(workspaceId);
      if (removed) await this.persist();
      return removed;
    });
  }

  /** The transport calls clear during shutdown; durable records remain on disk. */
  clear(): void {
    this.credentials.clear();
    this.loaded = false;
    this.loadPromise = null;
  }

  get size(): number {
    return this.credentials.size;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.readFromDisk();
    await this.loadPromise;
  }

  private async readFromDisk(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isDocument(parsed)) return;
      for (const record of parsed.credentials) {
        if (!isRecord(record)) continue;
        if (
          isValidWorkspaceId(record.workspaceId) &&
          /^[a-f0-9]{64}$/i.test(record.digest) &&
          isIsoTimestamp(record.configuredAt) &&
          (record.rotatedAt === undefined || isIsoTimestamp(record.rotatedAt))
        ) {
          this.credentials.set(record.workspaceId, {
            workspaceId: record.workspaceId,
            digest: record.digest.toLowerCase(),
            configuredAt: record.configuredAt,
            ...(record.rotatedAt ? { rotatedAt: record.rotatedAt } : {}),
          });
        }
      }
      this.trimRecords();
    } catch {
      // Corrupt or missing state is treated as an empty store. The next
      // mutation safely replaces it with a valid document.
    } finally {
      this.loaded = true;
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async persist(): Promise<void> {
    const document: WorkspaceMcpCredentialDocument = {
      schemaVersion: WORKSPACE_MCP_CREDENTIALS_SCHEMA_VERSION,
      updatedAt: nowIso(this.now),
      credentials: Array.from(this.credentials.values()),
    };
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private uniqueToken(): string {
    let token = this.generateToken();
    while (this.getAuthorization(token)) token = this.generateToken();
    return token;
  }

  private trimRecords(): void {
    while (this.credentials.size > this.maxCredentials) {
      const oldest = this.credentials.values().next().value as WorkspaceMcpCredentialRecord | undefined;
      if (!oldest) return;
      this.credentials.delete(oldest.workspaceId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDocument(value: unknown): value is WorkspaceMcpCredentialDocument {
  return (
    isRecord(value) &&
    value.schemaVersion === WORKSPACE_MCP_CREDENTIALS_SCHEMA_VERSION &&
    Array.isArray(value.credentials)
  );
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validateWorkspaceId(workspaceId: string): void {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new RangeError("Workspace MCP credential workspace ID is invalid");
  }
}

function validateMaxCredentials(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Maximum workspace MCP credentials must be a positive integer");
  }
  return value;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
