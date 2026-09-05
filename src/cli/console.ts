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
import { type DaemonCommandOptions, resolveDaemonContext } from "./daemon.js";

export const CLI_CONSOLE_URL = "https://cli.routermcp.com/cli" as const;

export interface ConsoleCommandOptions extends DaemonCommandOptions {
  /** Open the hosted console after printing the handoff. */
  open?: boolean;
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
