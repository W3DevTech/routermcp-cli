import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/compat/index.js", () => ({
  serve: vi.fn(),
}));

import { serve, type ServeOptions } from "../../../src/compat/index.js";
import {
  CONTROL_PLANE_PAIRING_EXCHANGE_PATH,
  CONTROL_PLANE_PAIRING_GRANTS_PATH,
  createPairingControl,
  ManagementCredentialStore,
  PAIRING_PROTOCOL_VERSION,
  PairingGrantStore,
  type PairingControl,
} from "../../../src/control-plane/index.js";
import {
  createHttpServerTransport,
  type HttpServerOptions,
} from "../../../src/transports/http-streamable.js";

const ROOT_TOKEN = "daemon-root-token";
const WORKSPACE_ID = "workspace-current";
const BASE = "http://127.0.0.1";

describe("control-plane pairing routes", () => {
  let fetchHandler: (request: Request) => Response | Promise<Response>;
  let handle: ReturnType<typeof createHttpServerTransport> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serve).mockImplementation((options: ServeOptions) => {
      fetchHandler = options.fetch;
      return {
        port: options.port,
        ready: Promise.resolve(options.port),
        stop: vi.fn(),
      };
    });
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    fetchHandler = undefined as never;
  });

  function createPairing(): PairingControl {
    const credentials = new ManagementCredentialStore({
      authority: "workspace",
      generateToken: () => "browser-management-token",
      canIssueWorkspace: (workspaceId) => workspaceId === WORKSPACE_ID,
    });
    return createPairingControl({
      grants: new PairingGrantStore(),
      resolveContext: (workspaceId) =>
        workspaceId === undefined || workspaceId === WORKSPACE_ID
          ? { profileId: "profile-a", instanceId: "instance-a", workspaceId: WORKSPACE_ID }
          : null,
      issueManagementCredential: (workspaceId) => credentials.issue(workspaceId),
    });
  }

  async function start(options: Partial<HttpServerOptions> = {}): Promise<void> {
    handle = createHttpServerTransport(7859, "127.0.0.1", {
      authToken: ROOT_TOKEN,
      pairing: createPairing(),
      ...options,
    });
    await handle.start();
  }

  function post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetchHandler(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  async function issueGrant(): Promise<{
    id: string;
    credential: string;
    challenge: { id: string; nonce: string };
  }> {
    const response = await post(
      CONTROL_PLANE_PAIRING_GRANTS_PATH,
      { protocolVersion: PAIRING_PROTOCOL_VERSION, label: "Hosted console" },
      ROOT_TOKEN,
    );
    expect(response.status).toBe(201);
    return response.json();
  }

  function exchangeBody(grant: Awaited<ReturnType<typeof issueGrant>>) {
    return {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      grant: grant.credential,
      challengeId: grant.challenge.id,
      nonce: grant.challenge.nonce,
    };
  }

  it("requires the daemon root token to issue grants", async () => {
    await start();

    const anonymous = await post(CONTROL_PLANE_PAIRING_GRANTS_PATH, {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
    });
    expect(anonymous.status).toBe(401);

    const grant = await issueGrant();
    expect(grant.credential).toEqual(expect.any(String));
    expect(grant).toMatchObject({ workspaceId: WORKSPACE_ID, state: "pending" });
  });

  it("exchanges a grant once for a browser credential without leaking the root token", async () => {
    await start();
    const grant = await issueGrant();

    const exchanged = await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, exchangeBody(grant));
    expect(exchanged.status).toBe(201);
    const text = await exchanged.text();
    expect(text).not.toContain(ROOT_TOKEN);
    expect(JSON.parse(text)).toMatchObject({
      accepted: true,
      grantId: grant.id,
      workspaceId: WORKSPACE_ID,
      scopes: ["management"],
      management: {
        token: "browser-management-token",
        scope: "management",
        authority: "workspace",
        workspaceId: WORKSPACE_ID,
      },
    });

    const replay = await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, exchangeBody(grant));
    expect(replay.status).toBe(404);
    expect(await replay.json()).toMatchObject({ error: "pairing_grant_consumed" });
  });

  it("rejects mismatched challenges and unknown workspaces", async () => {
    await start();
    const grant = await issueGrant();

    const mismatch = await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, {
      ...exchangeBody(grant),
      nonce: "not-the-nonce",
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: "pairing_challenge_mismatch" });

    const otherWorkspace = await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, {
      ...exchangeBody(grant),
      workspaceId: "workspace-other",
    });
    expect(otherWorkspace.status).toBe(404);
    expect(await otherWorkspace.json()).toMatchObject({ error: "pairing_grant_not_found" });

    const unknownIssue = await post(
      CONTROL_PLANE_PAIRING_GRANTS_PATH,
      { protocolVersion: PAIRING_PROTOCOL_VERSION, workspaceId: "workspace-other" },
      ROOT_TOKEN,
    );
    expect(unknownIssue.status).toBe(400);
  });

  it("lists and revokes grants behind the root token", async () => {
    await start();
    const grant = await issueGrant();
    const auth = { Authorization: `Bearer ${ROOT_TOKEN}` };

    const anonymousList = await fetchHandler(new Request(`${BASE}${CONTROL_PLANE_PAIRING_GRANTS_PATH}`));
    expect(anonymousList.status).toBe(401);

    const listed = await fetchHandler(
      new Request(`${BASE}${CONTROL_PLANE_PAIRING_GRANTS_PATH}`, { headers: auth }),
    );
    expect(listed.status).toBe(200);
    const { grants } = await listed.json();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: grant.id, state: "pending" });
    expect(grants[0]).not.toHaveProperty("credential");

    const revokeUrl = `${BASE}${CONTROL_PLANE_PAIRING_GRANTS_PATH}/${grant.id}`;
    const revoked = await fetchHandler(new Request(revokeUrl, { method: "DELETE", headers: auth }));
    expect(revoked.status).toBe(204);
    const again = await fetchHandler(new Request(revokeUrl, { method: "DELETE", headers: auth }));
    expect(again.status).toBe(404);

    const exchange = await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, exchangeBody(grant));
    expect(exchange.status).toBe(404);
    expect(await exchange.json()).toMatchObject({ error: "pairing_grant_revoked" });

    const active = await fetchHandler(
      new Request(`${BASE}${CONTROL_PLANE_PAIRING_GRANTS_PATH}`, { headers: auth }),
    );
    expect((await active.json()).grants).toHaveLength(0);
    const all = await fetchHandler(
      new Request(`${BASE}${CONTROL_PLANE_PAIRING_GRANTS_PATH}?includeInactive=true`, {
        headers: auth,
      }),
    );
    expect((await all.json()).grants[0]).toMatchObject({ id: grant.id, state: "revoked" });
  });

  it("validates methods, query parameters and bodies", async () => {
    await start();
    const auth = { Authorization: `Bearer ${ROOT_TOKEN}` };

    const getExchange = await fetchHandler(
      new Request(`${BASE}${CONTROL_PLANE_PAIRING_EXCHANGE_PATH}`),
    );
    expect(getExchange.status).toBe(405);

    const exchangeQuery = await post(`${CONTROL_PLANE_PAIRING_EXCHANGE_PATH}?x=1`, {});
    expect(exchangeQuery.status).toBe(400);

    const badFlag = await fetchHandler(
      new Request(`${BASE}${CONTROL_PLANE_PAIRING_GRANTS_PATH}?includeInactive=maybe`, {
        headers: auth,
      }),
    );
    expect(badFlag.status).toBe(400);

    const malformed = await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, { grant: "x" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "pairing_grant_invalid_input" });

    const oversized = await post(
      CONTROL_PLANE_PAIRING_EXCHANGE_PATH,
      JSON.stringify({ protocolVersion: PAIRING_PROTOCOL_VERSION, grant: "x".repeat(8_192) }),
    );
    expect(oversized.status).toBe(413);
  });

  it("is not mounted without a pairing control or a daemon auth token", async () => {
    await start({ pairing: undefined });
    expect((await post(CONTROL_PLANE_PAIRING_EXCHANGE_PATH, {})).status).toBe(404);
    await handle?.stop();

    await start({ authToken: undefined });
    const issue = await post(CONTROL_PLANE_PAIRING_GRANTS_PATH, {
      protocolVersion: PAIRING_PROTOCOL_VERSION,
    });
    expect(issue.status).toBe(404);
  });
});
