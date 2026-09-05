import { spawn, type ChildProcess } from "node:child_process";
import {
  CONTROL_PLANE_PATH,
  MANAGEMENT_CREDENTIAL_AUTHORITIES,
  MANAGEMENT_CREDENTIAL_HANDOFF_PATH,
  isValidWorkspaceId,
  type ManagementCredentialGrant,
} from "../control-plane/index.js";
import {
  ensureWorkspaceRunning,
  isLoopbackHost,
  type DaemonStatus,
} from "../daemon/index.js";
import { WORKSPACE_MCP_CREDENTIAL_PATH } from "../transports/index.js";
import { type DaemonCommandOptions, resolveDaemonContext } from "./daemon.js";

export const CLI_CONSOLE_URL = "https://cli.routermcp.com/cli" as const;

export interface ConsoleCommandOptions extends DaemonCommandOptions {
  /** Open the hosted console after printing the handoff. */
  open?: boolean;
}

export interface McpConfigCommandOptions extends DaemonCommandOptions {
  /** Replace the durable workspace credential and print the new secret. */
  rotate?: boolean;
}

export interface ConsoleHandoff {
  endpoint: string;
  expiresAt: string;
  profile?: string;
  scope: ManagementCredentialGrant["scope"];
  workspaceId?: string;
  workspaceMcpUrl?: string;
  url: string;
}

export interface WorkspaceMcpCredential {
  token?: string;
  configuredAt: string;
  rotatedAt?: string;
  created: boolean;
  rotated: boolean;
  scope: "mcp";
  workspaceId: string;
}

/** Validate the untrusted response returned by the local credential endpoint. */
export function isWorkspaceMcpCredential(
  value: unknown,
  workspaceId: string,
): value is WorkspaceMcpCredential {
  if (!isValidWorkspaceId(workspaceId)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const credential = value as Record<string, unknown>;
  return (
    (credential.token === undefined || (typeof credential.token === "string" && credential.token.length > 0)) &&
    typeof credential.configuredAt === "string" &&
    Number.isFinite(Date.parse(credential.configuredAt)) &&
    (credential.rotatedAt === undefined ||
      (typeof credential.rotatedAt === "string" && Number.isFinite(Date.parse(credential.rotatedAt)))) &&
    typeof credential.created === "boolean" &&
    typeof credential.rotated === "boolean" &&
    credential.scope === "mcp" &&
    credential.workspaceId === workspaceId
  );
}

/**
 * Start or reuse the profile daemon, mint a short-lived management grant, and
 * print a browser-safe URL fragment for the hosted console.
 */
export async function consoleCommand(options: ConsoleCommandOptions): Promise<void> {
  const context = await resolveDaemonContext(options);
  const status = await ensureWorkspaceRunning(context.workspace, {
    configFingerprint: context.configFingerprint,
    projectPath: context.projectPath,
    host: options.host ?? context.configuredHost,
    preferredPort: options.preferredPort ?? context.configuredPort,
    verbose: options.verbose,
  });

  if (!status.running || !status.controlUrl || !status.authToken) {
    throw new Error(status.reason ?? "RouterMCP daemon did not become ready for console access");
  }

  // The status returned by ensureWorkspaceRunning carries the workspace that
  // this invocation requested, even when another directory owns the shared
  // daemon host. Include that claim in the handoff so a browser credential can
  // never silently fall back to the host's primary workspace.
  const grant = await requestManagementCredential(status, fetch, status.workspaceId);
  const handoff = createConsoleHandoff(status, grant);

  if (options.json) {
    console.log(JSON.stringify(handoff, null, 2));
  } else {
    console.log(`RouterMCP hosted console (expires ${grant.expiresAt}):`);
    console.log(handoff.url);
    console.error("The handoff is short-lived and only grants control-plane access.");
  }

  if (options.open) {
    await openConsoleUrl(handoff.url);
  }
}

/**
 * Print the direct HTTP MCP configuration for the selected workspace.
 * Credentials are returned only when first created or explicitly rotated;
 * ordinary invocations never invalidate an existing MCP client config.
 */
export async function mcpConfigCommand(options: McpConfigCommandOptions): Promise<void> {
  const context = await resolveDaemonContext(options);
  const status = await ensureWorkspaceRunning(context.workspace, {
    configFingerprint: context.configFingerprint,
    projectPath: context.projectPath,
    host: options.host ?? context.configuredHost,
    preferredPort: options.preferredPort ?? context.configuredPort,
    verbose: options.verbose,
  });

  if (!status.running || !status.controlUrl || !status.authToken || !status.workspaceId) {
    throw new Error(status.reason ?? "RouterMCP daemon did not become ready for MCP configuration");
  }
  if (!status.workspaceMcpUrl) {
    throw new Error("The managed daemon did not provide a workspace MCP URL");
  }

  const credential = await requestWorkspaceMcpCredential(
    status,
    fetch,
    status.workspaceId,
    { rotate: options.rotate },
  );
  const output = {
    url: status.workspaceMcpUrl,
    workspaceId: status.workspaceId,
    ...(credential.token ? { authorization: `Bearer ${credential.token}` } : {}),
    configuredAt: credential.configuredAt,
    ...(credential.rotatedAt ? { rotatedAt: credential.rotatedAt } : {}),
    created: credential.created,
    rotated: credential.rotated,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("RouterMCP workspace MCP configuration:");
  console.log(`URL: ${output.url}`);
  if (output.authorization) {
    console.log(`Authorization: ${output.authorization}`);
    console.error("Store this authorization value in the MCP client configuration.");
  } else {
    console.log("Authorization: already configured (secret is not recoverable from RouterMCP).");
    console.error("Use --rotate to revoke the old credential and print a new one.");
  }
}

/** Request a browser-scoped grant using the private local daemon token. */
export async function requestManagementCredential(
  status: Pick<DaemonStatus, "controlUrl" | "authToken">,
  fetcher: typeof fetch = fetch,
  workspaceId?: string,
): Promise<ManagementCredentialGrant> {
  if (!status.controlUrl || !status.authToken) {
    throw new Error("The managed daemon did not provide private console credentials");
  }

  const endpoint = new URL(normalizeControlEndpoint(status.controlUrl));
  endpoint.pathname = MANAGEMENT_CREDENTIAL_HANDOFF_PATH;

  if (workspaceId !== undefined && !isValidWorkspaceId(workspaceId)) {
    throw new Error("The managed daemon returned an invalid workspace claim");
  }

  const requestBody = workspaceId === undefined ? undefined : JSON.stringify({ workspaceId });
  let response: Response;
  try {
    response = await fetcher(endpoint.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${status.authToken}`,
        ...(requestBody ? { "Content-Type": "application/json" } : {}),
      },
      cache: "no-store",
      ...(requestBody ? { body: requestBody } : {}),
    });
  } catch {
    throw new Error("The local daemon could not mint a console handoff");
  }

  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    // The generic response below avoids echoing any server-side credential data.
  }

  if (!response.ok) {
    throw new Error(`The local daemon rejected the console handoff (HTTP ${response.status})`);
  }

  const grant = parseManagementCredentialGrant(responseBody);
  if (!grant) {
    throw new Error(
      "The local daemon returned an invalid console handoff; restart it if it predates this CLI",
    );
  }

  return grant;
}

/** Create or explicitly rotate the durable credential for one direct workspace MCP endpoint. */
export async function requestWorkspaceMcpCredential(
  status: Pick<DaemonStatus, "controlUrl" | "authToken">,
  fetcher: typeof fetch = fetch,
  workspaceId: string,
  options: { rotate?: boolean } = {},
): Promise<WorkspaceMcpCredential> {
  if (!status.controlUrl || !status.authToken || !isValidWorkspaceId(workspaceId)) {
    throw new Error("The managed daemon did not provide workspace MCP credentials");
  }

  const endpoint = new URL(normalizeControlEndpoint(status.controlUrl));
  endpoint.pathname = WORKSPACE_MCP_CREDENTIAL_PATH;
  let response: Response;
  try {
    response = await fetcher(endpoint.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${status.authToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ workspaceId, ...(options.rotate ? { rotate: true } : {}) }),
    });
  } catch {
    throw new Error("The local daemon could not mint a workspace MCP credential");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Keep the error below generic so a daemon cannot echo credential material.
  }
  if (!response.ok || !isWorkspaceMcpCredential(body, workspaceId)) {
    throw new Error("The local daemon returned an invalid workspace MCP credential");
  }
  return body;
}

/** Build the fragment format consumed by the hosted console without URL query credentials. */
export function createConsoleHandoff(
  status: Pick<DaemonStatus, "controlUrl" | "profileId" | "workspaceMcpUrl">,
  grant: ManagementCredentialGrant,
): ConsoleHandoff {
  const endpoint = normalizeControlEndpoint(status.controlUrl);
  const payload = {
    endpoint,
    managementToken: grant.token,
    ...(status.profileId ? { profile: status.profileId } : {}),
    ...(grant.workspaceId ? { workspace: grant.workspaceId } : {}),
    ...(status.workspaceMcpUrl ? { workspaceMcpUrl: status.workspaceMcpUrl } : {}),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const url = `${CLI_CONSOLE_URL}#rmcp=${encodedPayload}`;

  return {
    endpoint,
    expiresAt: grant.expiresAt,
    ...(status.profileId ? { profile: status.profileId } : {}),
    scope: grant.scope,
    ...(grant.workspaceId ? { workspaceId: grant.workspaceId } : {}),
    ...(status.workspaceMcpUrl ? { workspaceMcpUrl: status.workspaceMcpUrl } : {}),
    url,
  };
}

/** Open a URL using the host platform's default browser without blocking the CLI. */
export async function openConsoleUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    child.once("error", (error) => reject(error));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function normalizeControlEndpoint(value: string | undefined): string {
  if (!value) throw new Error("The managed daemon did not provide a control endpoint");

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("The managed daemon returned an invalid control endpoint");
  }

  if (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname)) {
    throw new Error("The managed daemon control endpoint must be loopback HTTP");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The managed daemon control endpoint contains unsupported URL material");
  }

  const normalizedPath = endpoint.pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath !== "/" && normalizedPath !== CONTROL_PLANE_PATH) {
    throw new Error("The managed daemon control endpoint must use a root path or /api/v1 path");
  }

  return endpoint.origin;
}

/**
 * Parse the browser grant while retaining compatibility with the first
 * workspace-aware daemon release. That release already returned a
 * workspace-scoped grant, but did not include the later `authority` field.
 * A claimed legacy grant is unambiguously workspace-scoped; an unclaimed
 * legacy grant is rejected because treating it as host-wide would widen its
 * authorization beyond what the issuing daemon enforced.
 */
function parseManagementCredentialGrant(value: unknown): ManagementCredentialGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  if (
    typeof grant.token !== "string" ||
    grant.token.length === 0 ||
    typeof grant.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    grant.scope !== "management" ||
    (grant.workspaceId !== undefined && !isValidWorkspaceId(grant.workspaceId))
  ) {
    return null;
  }

  if (
    grant.authority === MANAGEMENT_CREDENTIAL_AUTHORITIES[0] ||
    grant.authority === MANAGEMENT_CREDENTIAL_AUTHORITIES[1]
  ) {
    return {
      token: grant.token,
      expiresAt: grant.expiresAt,
      scope: "management",
      authority: grant.authority,
      ...(grant.workspaceId ? { workspaceId: grant.workspaceId } : {}),
    };
  }

  if (grant.authority === undefined && grant.workspaceId !== undefined) {
    return {
      token: grant.token,
      expiresAt: grant.expiresAt,
      scope: "management",
      authority: "workspace",
      workspaceId: grant.workspaceId,
    };
  }

  return null;
}
