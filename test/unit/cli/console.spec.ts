import { describe, expect, it, vi } from "vitest";
import { MANAGEMENT_CREDENTIAL_SCOPE } from "../../../src/control-plane/index.js";
import {
  CLI_CONSOLE_URL,
  createConsoleHandoff,
  isWorkspaceMcpCredential,
  requestManagementCredential,
  requestWorkspaceMcpCredential,
} from "../../../src/cli/console.js";

describe("console handoff", () => {
  it("creates an opaque hosted-console fragment without the local root token", () => {
    const handoff = createConsoleHandoff(
      {
        controlUrl: "http://127.0.0.1:7858",
        profileId: "profile-1",
      },
      {
        token: "management-token",
        expiresAt: "2026-01-01T00:05:00.000Z",
        scope: MANAGEMENT_CREDENTIAL_SCOPE,
        authority: "host",
      },
    );

    expect(handoff.endpoint).toBe("http://127.0.0.1:7858");
    expect(handoff.url.startsWith(`${CLI_CONSOLE_URL}#rmcp=`)).toBe(true);
    expect(handoff.url).not.toContain("local-root-token");

    const encoded = handoff.url.slice(`${CLI_CONSOLE_URL}#rmcp=`.length);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      endpoint: "http://127.0.0.1:7858",
      managementToken: "management-token",
      profile: "profile-1",
    });
  });

  it("mints a grant through the loopback endpoint with the private token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "management-token",
          expiresAt: "2026-01-01T00:05:00.000Z",
          scope: MANAGEMENT_CREDENTIAL_SCOPE,
          authority: "host",
        }),
        { status: 201 },
      ),
    );

    const grant = await requestManagementCredential(
      { controlUrl: "http://127.0.0.1:7858", authToken: "local-root-token" },
      fetcher,
    );

    expect(grant.token).toBe("management-token");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7858/api/v1/management/handoff",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer local-root-token",
        }),
      }),
    );
  });

  it("includes the selected workspace claim in the local handoff request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "management-token",
          expiresAt: "2026-01-01T00:05:00.000Z",
          scope: MANAGEMENT_CREDENTIAL_SCOPE,
          authority: "host",
          workspaceId: "workspace-other",
        }),
        { status: 201 },
      ),
    );

    const grant = await requestManagementCredential(
      {
        controlUrl: "http://127.0.0.1:7858",
        authToken: "local-root-token",
      },
      fetcher,
      "workspace-other",
    );

    expect(grant.workspaceId).toBe("workspace-other");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7858/api/v1/management/handoff",
      expect.objectContaining({
        body: JSON.stringify({ workspaceId: "workspace-other" }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("accepts a workspace-scoped grant from a pre-authority daemon", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "legacy-management-token",
          expiresAt: "2026-01-01T00:05:00.000Z",
          scope: MANAGEMENT_CREDENTIAL_SCOPE,
          workspaceId: "workspace-current",
        }),
        { status: 201 },
      ),
    );

    const grant = await requestManagementCredential(
      {
        controlUrl: "http://127.0.0.1:7858",
        authToken: "local-root-token",
      },
      fetcher,
      "workspace-current",
    );

    expect(grant).toEqual({
      token: "legacy-management-token",
      expiresAt: "2026-01-01T00:05:00.000Z",
      scope: MANAGEMENT_CREDENTIAL_SCOPE,
      authority: "workspace",
      workspaceId: "workspace-current",
    });
  });

  it("does not infer host authority for an unclaimed legacy grant", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "legacy-management-token",
          expiresAt: "2026-01-01T00:05:00.000Z",
          scope: MANAGEMENT_CREDENTIAL_SCOPE,
        }),
        { status: 201 },
      ),
    );

    await expect(
      requestManagementCredential(
        { controlUrl: "http://127.0.0.1:7858", authToken: "local-root-token" },
        fetcher,
      ),
    ).rejects.toThrow("restart it if it predates this CLI");
  });

  it("normalizes a canonical control-plane endpoint before requesting a handoff", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "management-token",
          expiresAt: "2026-01-01T00:05:00.000Z",
          scope: MANAGEMENT_CREDENTIAL_SCOPE,
          authority: "host",
        }),
        { status: 201 },
      ),
    );

    await requestManagementCredential(
      { controlUrl: "http://127.0.0.1:7858/api/v1/", authToken: "local-root-token" },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7858/api/v1/management/handoff",
      expect.any(Object),
    );
  });

  it("rejects non-loopback or invalid grant responses", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      requestManagementCredential(
        { controlUrl: "https://example.com", authToken: "local-root-token" },
        fetcher,
      ),
    ).rejects.toThrow("loopback HTTP");
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      requestManagementCredential(
        { controlUrl: "http://127.0.0.1:7858/daemon", authToken: "local-root-token" },
        fetcher,
      ),
    ).rejects.toThrow("root path");
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "missing-expiry" }), { status: 201 }),
    );
    await expect(
      requestManagementCredential(
        { controlUrl: "http://127.0.0.1:7858", authToken: "local-root-token" },
        fetcher,
      ),
    ).rejects.toThrow("invalid console handoff");
  });

  it("mints a workspace-scoped MCP credential through the loopback endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "workspace-mcp-token",
          configuredAt: "2026-01-01T00:00:00.000Z",
          created: true,
          rotated: false,
          scope: "mcp",
          workspaceId: "workspace-current",
        }),
        { status: 201 },
      ),
    );

    const credential = await requestWorkspaceMcpCredential(
      { controlUrl: "http://127.0.0.1:7858", authToken: "local-root-token" },
      fetcher,
      "workspace-current",
    );

    expect(credential).toEqual({
      token: "workspace-mcp-token",
      configuredAt: "2026-01-01T00:00:00.000Z",
      created: true,
      rotated: false,
      scope: "mcp",
      workspaceId: "workspace-current",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7858/api/v1/management/mcp-credential",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer local-root-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ workspaceId: "workspace-current" }),
      }),
    );
  });

  it("rejects workspace MCP credentials for another workspace or malformed expiry", () => {
    expect(
      isWorkspaceMcpCredential(
        {
          token: "workspace-mcp-token",
          configuredAt: "2026-01-01T00:00:00.000Z",
          created: true,
          rotated: false,
          scope: "mcp",
          workspaceId: "workspace-current",
        },
        "workspace-current",
      ),
    ).toBe(true);
    expect(
      isWorkspaceMcpCredential(
        {
          token: "workspace-mcp-token",
          configuredAt: "2026-01-01T00:00:00.000Z",
          created: true,
          rotated: false,
          scope: "mcp",
          workspaceId: "workspace-other",
        },
        "workspace-current",
      ),
    ).toBe(false);
    expect(
      isWorkspaceMcpCredential(
        {
          token: "workspace-mcp-token",
          configuredAt: "not-a-date",
          created: true,
          rotated: false,
          scope: "mcp",
          workspaceId: "workspace-current",
        },
        "workspace-current",
      ),
    ).toBe(false);
  });

  it("rejects invalid workspace MCP credential responses without echoing them", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "workspace-mcp-token",
          configuredAt: "2026-01-01T00:00:00.000Z",
          created: true,
          rotated: false,
          scope: "management",
          workspaceId: "workspace-current",
        }),
        { status: 201 },
      ),
    );

    await expect(
      requestWorkspaceMcpCredential(
        { controlUrl: "http://127.0.0.1:7858", authToken: "local-root-token" },
        fetcher,
        "workspace-current",
      ),
    ).rejects.toThrow("invalid workspace MCP credential");
  });
});
