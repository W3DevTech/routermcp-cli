import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs, main, getCurrentCommand, getCurrentArgs } from "../../../src/cli/index.js";

describe("parseArgs", () => {
  describe("command detection", () => {
    it("defaults to 'serve' when no command provided", () => {
      const { command } = parseArgs([]);
      expect(command).toBe("serve");
    });

    it("parses 'serve' command", () => {
      const { command } = parseArgs(["serve"]);
      expect(command).toBe("serve");
    });

    it("parses 'connect' command", () => {
      const { command } = parseArgs(["connect"]);
      expect(command).toBe("connect");
    });

    it("parses 'config' command", () => {
      const { command } = parseArgs(["config"]);
      expect(command).toBe("config");
    });

    it("parses 'tunnel' command", () => {
      const { command } = parseArgs(["tunnel"]);
      expect(command).toBe("tunnel");
    });

    it("parses 'proxy' command", () => {
      const { command } = parseArgs(["proxy"]);
      expect(command).toBe("proxy");
    });

    it("parses 'doctor' command", () => {
      const { command } = parseArgs(["doctor"]);
      expect(command).toBe("doctor");
    });

    it("parses 'telemetry' command", () => {
      const { command } = parseArgs(["telemetry", "status"]);
      expect(command).toBe("telemetry");
    });

    it("parses 'help' command", () => {
      const { command } = parseArgs(["help"]);
      expect(command).toBe("help");
    });

    it("parses '--help' flag as help command", () => {
      const { command } = parseArgs(["--help"]);
      expect(command).toBe("help");
    });

    it("parses '-h' flag as help command", () => {
      const { command } = parseArgs(["-h"]);
      expect(command).toBe("help");
    });
  });

  describe("serve options", () => {
    it("parses --config with path", () => {
      const { options } = parseArgs(["serve", "--config", "/path/to/config.jsonc"]);
      expect(options.config).toBe("/path/to/config.jsonc");
    });

    it("parses -c shorthand for config", () => {
      const { options } = parseArgs(["serve", "-c", "my-config.jsonc"]);
      expect(options.config).toBe("my-config.jsonc");
    });

    it("parses --stdio flag", () => {
      const { options } = parseArgs(["serve", "--stdio"]);
      expect(options.stdio).toBe(true);
    });

    it("parses --http with port number", () => {
      const { options } = parseArgs(["serve", "--http", "3000"]);
      expect(options.http).toBe(3000);
    });

    it("parses --verbose flag", () => {
      const { options } = parseArgs(["serve", "--verbose"]);
      expect(options.verbose).toBe(true);
    });

    it("parses -v shorthand for verbose", () => {
      const { options } = parseArgs(["serve", "-v"]);
      expect(options.verbose).toBe(true);
    });

    it("parses --daemon-mode flag", () => {
      const { options } = parseArgs(["serve", "--daemon-mode"]);
      expect(options.daemonMode).toBe(true);
    });

    it("parses --socket with path", () => {
      const { options } = parseArgs(["serve", "--socket", "/tmp/routermcp.sock"]);
      expect(options.socket).toBe("/tmp/routermcp.sock");
    });

    it("parses --clear flag", () => {
      const { options } = parseArgs(["serve", "--clear"]);
      expect(options.clearCache).toBe(true);
    });

    it("parses multiple serve options together", () => {
      const { command, options } = parseArgs([
        "serve",
        "-c",
        "config.jsonc",
        "--http",
        "8080",
        "-v",
        "--daemon-mode",
      ]);
      expect(command).toBe("serve");
      expect(options.config).toBe("config.jsonc");
      expect(options.http).toBe(8080);
      expect(options.verbose).toBe(true);
      expect(options.daemonMode).toBe(true);
    });
  });

  describe("connect options", () => {
    it("parses --project with path", () => {
      const { options } = parseArgs(["connect", "--project", "/path/to/project"]);
      expect(options.project).toBe("/path/to/project");
    });

    it("parses connect with config and verbose", () => {
      const { command, options } = parseArgs(["connect", "-c", "config.jsonc", "-v"]);
      expect(command).toBe("connect");
      expect(options.config).toBe("config.jsonc");
      expect(options.verbose).toBe(true);
    });
  });

  describe("proxy options", () => {
    it("parses --stdio with command string for proxy", () => {
      const { options } = parseArgs(["proxy", "--stdio", "npx -y @modelcontextprotocol/server-everything"]);
      expect(options.proxyStdio).toBe("npx -y @modelcontextprotocol/server-everything");
    });

    it("parses --outputTransport sse", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--outputTransport", "sse"]);
      expect(options.outputTransport).toBe("sse");
    });

    it("parses --outputTransport streamableHttp", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--outputTransport", "streamableHttp"]);
      expect(options.outputTransport).toBe("streamableHttp");
    });

    it("parses --port with number", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--port", "9000"]);
      expect(options.port).toBe(9000);
    });

    it("parses -p shorthand for port", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "-p", "9000"]);
      expect(options.port).toBe(9000);
    });

    it("parses --basePath", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--basePath", "/api/v1"]);
      expect(options.basePath).toBe("/api/v1");
    });

    it("parses --ssePath", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--ssePath", "/events"]);
      expect(options.ssePath).toBe("/events");
    });

    it("parses --messagePath", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--messagePath", "/msg"]);
      expect(options.messagePath).toBe("/msg");
    });

    it("parses --streamableHttpPath", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--streamableHttpPath", "/stream"]);
      expect(options.streamableHttpPath).toBe("/stream");
    });

    it("parses --stateful flag", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--stateful"]);
      expect(options.stateful).toBe(true);
    });

    it("parses --sessionTimeout with milliseconds", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--sessionTimeout", "120000"]);
      expect(options.sessionTimeout).toBe(120000);
    });

    it("parses --healthEndpoint", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--healthEndpoint", "/ping"]);
      expect(options.healthEndpoint).toBe("/ping");
    });

    it("parses --cors flag", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--cors"]);
      expect(options.cors).toBe(true);
    });

    it("parses --no-cors flag", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--no-cors"]);
      expect(options.noCors).toBe(true);
    });

    it("parses --maxRestarts with number", () => {
      const { options } = parseArgs(["proxy", "--stdio", "cmd", "--maxRestarts", "5"]);
      expect(options.maxRestarts).toBe(5);
    });

    it("parses full proxy options", () => {
      const { command, options } = parseArgs([
        "proxy",
        "--stdio",
        "node server.js",
        "--outputTransport",
        "streamableHttp",
        "-p",
        "3000",
        "--stateful",
        "--sessionTimeout",
        "60000",
        "-v",
      ]);
      expect(command).toBe("proxy");
      expect(options.proxyStdio).toBe("node server.js");
      expect(options.outputTransport).toBe("streamableHttp");
      expect(options.port).toBe(3000);
      expect(options.stateful).toBe(true);
      expect(options.sessionTimeout).toBe(60000);
      expect(options.verbose).toBe(true);
    });
  });

  describe("tunnel options", () => {
    it("parses --tunnel=cloudflare", () => {
      const { options } = parseArgs(["tunnel", "--tunnel=cloudflare"]);
      expect(options.tunnel).toBe("cloudflare");
    });

    it("parses --tunnel=ngrok", () => {
      const { options } = parseArgs(["tunnel", "--tunnel=ngrok"]);
      expect(options.tunnel).toBe("ngrok");
    });

    it("parses --tunnel=routermcp-cloud", () => {
      const { options } = parseArgs(["tunnel", "--tunnel=routermcp-cloud"]);
      expect(options.tunnel).toBe("routermcp-cloud");
    });

    it("parses --tunnel=standalone", () => {
      const { options } = parseArgs(["tunnel", "--tunnel=standalone"]);
      expect(options.tunnel).toBe("standalone");
    });

    it("parses tunnel with port", () => {
      const { options } = parseArgs(["tunnel", "--tunnel=cloudflare", "-p", "8080"]);
      expect(options.tunnel).toBe("cloudflare");
      expect(options.port).toBe(8080);
    });
  });

  describe("oauth subcommands", () => {
    it("parses 'oauth status'", () => {
      const { command, options } = parseArgs(["oauth", "status"]);
      expect(command).toBe("oauth");
      expect(options.oauthSubcommand).toEqual({ action: "status" });
    });

    it("parses 'oauth login <serverName>'", () => {
      const { command, options } = parseArgs(["oauth", "login", "my-server"]);
      expect(command).toBe("oauth");
      expect(options.oauthSubcommand).toEqual({ action: "login", serverName: "my-server" });
    });

    it("parses 'oauth logout <serverName>'", () => {
      const { command, options } = parseArgs(["oauth", "logout", "my-server"]);
      expect(command).toBe("oauth");
      expect(options.oauthSubcommand).toEqual({ action: "logout", serverName: "my-server" });
    });

    it("parses 'oauth logout --all'", () => {
      const { command, options } = parseArgs(["oauth", "logout", "--all"]);
      expect(command).toBe("oauth");
      expect(options.oauthSubcommand).toEqual({ action: "logout", all: true });
    });
  });

  describe("telemetry subcommands", () => {
    it("parses 'telemetry enable'", () => {
      const { command, options } = parseArgs(["telemetry", "enable"]);
      expect(command).toBe("telemetry");
      expect(options.telemetryAction).toBe("enable");
    });

    it("parses 'telemetry disable'", () => {
      const { command, options } = parseArgs(["telemetry", "disable"]);
      expect(command).toBe("telemetry");
      expect(options.telemetryAction).toBe("disable");
    });

    it("parses 'telemetry status'", () => {
      const { command, options } = parseArgs(["telemetry", "status"]);
      expect(command).toBe("telemetry");
      expect(options.telemetryAction).toBe("status");
    });
  });

  describe("edge cases", () => {
    it("handles options before command", () => {
      const { command, options } = parseArgs(["-v", "serve", "--http", "3000"]);
      expect(command).toBe("serve");
      expect(options.verbose).toBe(true);
      expect(options.http).toBe(3000);
    });

    it("handles empty args array", () => {
      const { command, options } = parseArgs([]);
      expect(command).toBe("serve");
      expect(options).toEqual({});
    });

    it("handles only options without explicit command", () => {
      const { command, options } = parseArgs(["--http", "5000", "-v"]);
      expect(command).toBe("serve");
      expect(options.http).toBe(5000);
      expect(options.verbose).toBe(true);
    });
  });
});

describe("getCurrentCommand", () => {
  it("returns the current command after main is called", async () => {
    const originalExit = process.exit;
    (process as { exit: (code?: number) => never }).exit = (() => {
      throw new Error("process.exit called");
    }) as never;

    try {
      await main(["help"]);
    } catch {
      // main might call process.exit or throw
    }

    expect(getCurrentCommand()).toBe("help");

    process.exit = originalExit;
  });
});

describe("getCurrentArgs", () => {
  it("returns the current args after main is called", async () => {
    const originalExit = process.exit;
    (process as { exit: (code?: number) => never }).exit = (() => {
      throw new Error("process.exit called");
    }) as never;

    const testArgs = ["help", "-v"];
    try {
      await main(testArgs);
    } catch {
      // main might call process.exit or throw
    }

    expect(getCurrentArgs()).toEqual(testArgs);

    process.exit = originalExit;
  });
});
