import * as p from "@clack/prompts";
import { loadConfig } from "../config/loader.js";
import type { ServerConfig } from "../config/types.js";
import {
  loadOAuthStorage,
  clearOAuthStorage,
  clearAllOAuthStorage,
  listOAuthServers,
  isTokenExpired,
  getServerHostHash,
} from "../oauth/storage.js";
import { RouterMcpOAuthProvider, DEFAULT_CLIENT_NAME } from "../oauth/provider.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

function formatExpiry(expiresAt: number | undefined): string {
  if (!expiresAt) return "-";

  const now = Math.floor(Date.now() / 1000);
  const diff = expiresAt - now;

  if (diff < 0) {
    const ago = Math.abs(diff);
    if (ago < 60) return `${ago}s ago`;
    if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
    return `${Math.floor(ago / 86400)}d ago`;
  }

  if (diff < 60) return `in ${diff}s`;
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  return `in ${Math.floor(diff / 86400)}d`;
}

export async function oauthStatusCommand(configPath: string): Promise<void> {
  p.intro("OAuth Status for RouterMCP servers");

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Failed to load config: ${msg}`);
    p.outro("Command failed");
    process.exit(1);
  }

  console.log("\n" + "─".repeat(85));
  console.log(
    `${"Server".padEnd(18)} ${"URL".padEnd(35)} ${"Status".padEnd(12)} ${"Expires".padEnd(15)}`,
  );
  console.log("─".repeat(85));

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    let url = "(stdio)";
    let status = "N/A";
    let expires = "-";

    if (serverConfig.transport === "http-streamable" && serverConfig.url) {
      url = serverConfig.url;
      if (url.length > 33) {
        url = url.substring(0, 30) + "...";
      }

      if (serverConfig.oauth?.enabled !== false && serverConfig.oauth) {
        const stored = await loadOAuthStorage(serverConfig.url);

        if (!stored?.tokens) {
          status = "No tokens";
        } else if (isTokenExpired(stored.tokens, 0)) {
          status = "Expired";
          expires = formatExpiry(stored.tokens.expires_at);
        } else {
          status = "Valid";
          expires = formatExpiry(stored.tokens.expires_at);
        }
      }
    }

    console.log(`${name.padEnd(18)} ${url.padEnd(35)} ${status.padEnd(12)} ${expires.padEnd(15)}`);
  }

  console.log("─".repeat(85));
  p.log.info("\nRun 'routermcp doctor' to authenticate servers.");
  p.outro("");
}

export async function oauthLoginCommand(configPath: string, serverName: string): Promise<void> {
  if (!serverName) {
    p.log.error("Server name is required");
    console.log("Usage: routermcp oauth login <server-name>");
    process.exit(1);
  }

  p.intro(`OAuth Login for ${serverName}`);

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Failed to load config: ${msg}`);
    p.outro("Command failed");
    process.exit(1);
  }

  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) {
    p.log.error(`Server '${serverName}' not found in configuration`);
    p.outro("Command failed");
    process.exit(1);
  }

  if (serverConfig.transport !== "http-streamable" || !serverConfig.url) {
    p.log.error(`Server '${serverName}' is not an HTTP server`);
    p.outro("Command failed");
    process.exit(1);
  }

  if (!serverConfig.oauth) {
    p.log.error(`Server '${serverName}' does not have OAuth configured`);
    p.outro("Command failed");
    process.exit(1);
  }

  const provider = new RouterMcpOAuthProvider(
    serverName,
    serverConfig.url,
    {
      clientId: serverConfig.oauth.clientId,
      clientSecret: serverConfig.oauth.clientSecret,
      scopes: serverConfig.oauth.scopes,
      clientName: serverConfig.oauth.clientName ?? DEFAULT_CLIENT_NAME,
    },
    {
      onAuthorizationUrl: (url) => {
        p.log.info(`\nPlease visit this URL to authorize RouterMCP:\n`);
        console.log(`  ${url.toString()}\n`);
        p.log.info("Waiting for authorization... (timeout: 5 minutes)");
        p.log.info("[Press Ctrl+C to cancel]\n");
      },
      onAuthorizationComplete: () => {},
      onError: (err) => {
        p.log.error(`Authorization error: ${err.message}`);
      },
    },
  );

  try {
    await provider.startCallbackServer();

    const firstResult = await auth(provider, {
      serverUrl: serverConfig.url,
    });

    if (firstResult === "AUTHORIZED") {
      await provider.stopCallbackServer();
      p.log.success(`Authorization successful for ${serverName}!`);
      return;
    }

    if (firstResult !== "REDIRECT") {
      await provider.stopCallbackServer();
      p.log.error(`Unexpected auth result: ${firstResult}`);
      p.outro("Command failed");
      process.exit(1);
    }

    const authCode = await provider.waitForAuthorizationCode();

    const secondResult = await auth(provider, {
      serverUrl: serverConfig.url,
      authorizationCode: authCode,
    });

    await provider.stopCallbackServer();

    if (secondResult === "AUTHORIZED") {
      p.log.success(`Authorization successful for ${serverName}!`);
    } else {
      p.log.error(`Token exchange failed: ${secondResult}`);
      p.outro("Command failed");
      process.exit(1);
    }
  } catch (err) {
    await provider.stopCallbackServer();
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Authentication failed: ${msg}`);
    p.outro("Command failed");
    process.exit(1);
  }

  p.outro("Login complete");
}

export async function oauthLogoutCommand(serverName: string | null, all: boolean): Promise<void> {
  if (all) {
    p.intro("OAuth Logout - Clear All");

    const confirm = await p.confirm({
      message: "Are you sure you want to clear all OAuth tokens?",
      initialValue: false,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.outro("Cancelled");
      return;
    }

    await clearAllOAuthStorage();
    p.log.success("All OAuth tokens cleared");
    p.outro("Logout complete");
    return;
  }

  if (!serverName) {
    p.log.error("Server name is required (or use --all)");
    console.log("Usage: routermcp oauth logout <server-name>");
    console.log("       routermcp oauth logout --all");
    process.exit(1);
  }

  p.intro(`OAuth Logout for ${serverName}`);

  const servers = await listOAuthServers();
  const server = servers.find((s) => {
    try {
      const url = new URL(s.serverUrl);
      return url.hostname.includes(serverName) || s.serverUrl.includes(serverName);
    } catch {
      return s.serverUrl.includes(serverName);
    }
  });

  if (!server) {
    p.log.warning(`No OAuth tokens found for '${serverName}'`);
    p.log.info("Available servers with OAuth tokens:");
    for (const s of servers) {
      console.log(`  - ${s.serverUrl}`);
    }
    p.outro("");
    return;
  }

  await clearOAuthStorage(server.serverUrl);
  p.log.success(`OAuth tokens cleared for ${server.serverUrl}`);
  p.outro("Logout complete");
}
