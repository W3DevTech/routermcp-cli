/**
 * Tests for CLI argument parsing
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/cli/index.js";

describe("parseArgs", () => {
  test("parses help flag", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("parses version flag", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  test("parses command", () => {
    expect(parseArgs(["serve"]).command).toBe("serve");
    expect(parseArgs(["config"]).command).toBe("config");
  });

  test("parses config option", () => {
    expect(parseArgs(["--config", "my-config.jsonc"]).config).toBe("my-config.jsonc");
    expect(parseArgs(["-c", "test.json"]).config).toBe("test.json");
  });

  test("parses transport option", () => {
    expect(parseArgs(["--transport", "stdio"]).transport).toBe("stdio");
    expect(parseArgs(["-t", "http-streamable"]).transport).toBe("http-streamable");
  });

  test("parses port option", () => {
    expect(parseArgs(["--port", "3000"]).port).toBe(3000);
    expect(parseArgs(["-p", "8080"]).port).toBe(8080);
  });

  test("parses multiple options", () => {
    const args = parseArgs(["serve", "-c", "config.json", "-t", "stdio"]);
    expect(args.command).toBe("serve");
    expect(args.config).toBe("config.json");
    expect(args.transport).toBe("stdio");
  });

  test("returns empty object for no args", () => {
    const args = parseArgs([]);
    expect(args).toEqual({});
  });
});
