import { describe, expect, it } from "vitest";
import { buildTelemetryEvent } from "../../../src/telemetry/reporter.js";
import { REDACTED, redactArgs, redactText } from "../../../src/telemetry/redact.js";

describe("telemetry/redact", () => {
  describe("redactArgs", () => {
    it("keeps flag names and drops every value", () => {
      expect(
        redactArgs([
          "--stdio",
          "npx server --token abc123",
          "--port=7858",
          "-v",
          "./routermcp.jsonc",
          "--",
        ]),
      ).toEqual([
        "--stdio",
        REDACTED,
        `--port=${REDACTED}`,
        "-v",
        REDACTED,
        REDACTED,
      ]);
    });
  });

  describe("redactText", () => {
    const home = "/home/alice";

    it("replaces the home directory with ~", () => {
      expect(redactText("ENOENT: /home/alice/project/routermcp.jsonc", home)).toBe(
        "ENOENT: ~/project/routermcp.jsonc",
      );
    });

    it("strips URL credentials, query strings and fragments but keeps the endpoint", () => {
      expect(
        redactText("fetch failed: https://user:pw@api.example.com/mcp?key=s3cr3t#frag", home),
      ).toBe(`fetch failed: https://api.example.com/mcp${REDACTED}`);
      expect(redactText("connect https://mcp.example.com/mcp refused", home)).toBe(
        "connect https://mcp.example.com/mcp refused",
      );
    });

    it("masks bearer tokens and secret-looking key/value pairs", () => {
      expect(redactText("Authorization: Bearer eyJhbGciOi.payload.sig", home)).toBe(
        `Authorization: Bearer ${REDACTED}`,
      );
      expect(redactText('api_key=abcdef GITHUB_TOKEN: "ghp_xyz" password=hunter2', home)).toBe(
        `api_key=${REDACTED} GITHUB_TOKEN: "${REDACTED}" password=${REDACTED}`,
      );
    });

    it("leaves ordinary messages untouched", () => {
      expect(redactText("Upstream server 'github' timed out after 30000ms", home)).toBe(
        "Upstream server 'github' timed out after 30000ms",
      );
    });
  });

  it("is applied to the message, stack and args of telemetry events", () => {
    const error = new Error("401 from https://api.example.com/mcp?token=abc");
    error.stack = `Error: Bearer abc.def\n    at ${process.env.HOME ?? "/home/user"}/x.ts:1:1`;
    const event = buildTelemetryEvent(error, {
      command: "serve",
      args: ["--config", "/secret/path.jsonc"],
    });

    expect(event.error.message).toBe(`401 from https://api.example.com/mcp${REDACTED}`);
    expect(event.error.stack).not.toContain("abc.def");
    expect(event.cli.args).toEqual(["--config", REDACTED]);
  });
});
