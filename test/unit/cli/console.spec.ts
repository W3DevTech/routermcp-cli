import { describe, expect, it, vi } from "vitest";
import { MANAGEMENT_CREDENTIAL_SCOPE } from "../../../src/control-plane/index.js";
import {
  CLI_CONSOLE_URL,
  createConsoleHandoff,
  requestManagementCredential,
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

  it("normalizes a canonical control-plane endpoint before requesting a handoff", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "management-token",
          expiresAt: "2026-01-01T00:05:00.000Z",
          scope: MANAGEMENT_CREDENTIAL_SCOPE,
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
});
