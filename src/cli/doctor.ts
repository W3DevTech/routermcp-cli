import * as p from "@clack/prompts";
import { auth, discoverOAuthMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { getConfigLocations, getScopeLabel, loadConfig } from "../config/loader.js";
import type { ConfigScope, OAuthConfig, ServerConfig } from "../config/types.js";
import { DEFAULT_CLIENT_NAME, RouterMcpOAuthProvider } from "../oauth/provider.js";
import { isTokenExpired, loadOAuthStorage } from "../oauth/storage.js";

interface ServerOAuthStatus {
  name: string;
  transport: string;
  url?: string;
  needsOAuth: boolean;
  hasTokens: boolean;
  isExpired: boolean;
  status: "ok" | "needs-auth" | "expired" | "n/a" | "unknown";
  oauthConfig?: OAuthConfig;
}

async function probeServerForOAuth(url: string): Promise<boolean> {
  try {
    const metadata = await discoverOAuthMetadata(url);
    if (metadata) {
      return true;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });

    if (response.status === 401) {
      return true;
    }

    const wwwAuth = response.headers.get("www-authenticate");
    if (wwwAuth) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function getServerOAuthStatus(
  name: string,
  config: ServerConfig,
): Promise<ServerOAuthStatus> {
  if (config.transport !== "http-streamable" || !config.url) {
    return {
      name,
      transport: config.transport,
      needsOAuth: false,
      hasTokens: false,
      isExpired: false,
      status: "n/a",
    };
  }

  if (config.oauth?.enabled === false) {
    return {
      name,
      transport: config.transport,
      url: config.url,
      needsOAuth: false,
      hasTokens: false,
      isExpired: false,
      status: "n/a",
    };
  }

  const stored = await loadOAuthStorage(config.url);
  const hasTokens = !!stored?.tokens?.access_token;
  const isExpired = hasTokens && isTokenExpired(stored?.tokens, 0);

  if (hasTokens && !isExpired) {
    return {
      name,
      transport: config.transport,
      url: config.url,
      needsOAuth: true,
      hasTokens: true,
      isExpired: false,
      status: "ok",
      oauthConfig: config.oauth,
    };
  }

  if (hasTokens && isExpired) {
    return {
      name,
      transport: config.transport,
      url: config.url,
      needsOAuth: true,
      hasTokens: true,
      isExpired: true,
      status: "expired",
      oauthConfig: config.oauth,
    };
  }

  const serverNeedsOAuth = await probeServerForOAuth(config.url);

  if (!serverNeedsOAuth) {
    return {
      name,
      transport: config.transport,
      url: config.url,
      needsOAuth: false,
      hasTokens: false,
      isExpired: false,
      status: "n/a",
    };
  }

  return {
    name,
    transport: config.transport,
    url: config.url,
    needsOAuth: true,
    hasTokens: false,
    isExpired: false,
    status: "needs-auth",
    oauthConfig: config.oauth,
  };
}

async function authenticateServer(
  name: string,
  url: string,
  oauthConfig?: OAuthConfig,
): Promise<boolean> {
  const provider = new RouterMcpOAuthProvider(
    name,
    url,
    {
      clientId: oauthConfig?.clientId,
      clientSecret: oauthConfig?.clientSecret,
      scopes: oauthConfig?.scopes,
      clientName: oauthConfig?.clientName ?? DEFAULT_CLIENT_NAME,
    },
    {
      onAuthorizationUrl: (authUrl) => {
        p.log.info("\nPlease visit this URL to authorize RouterMCP:\n");
        console.log(`  ${authUrl.toString()}\n`);
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
      serverUrl: url,
    });

    if (firstResult === "AUTHORIZED") {
      await provider.stopCallbackServer();
      return true;
    }

    if (firstResult !== "REDIRECT") {
      await provider.stopCallbackServer();
      p.log.error(`Unexpected auth result: ${firstResult}`);
      return false;
    }

    const authCode = await provider.waitForAuthorizationCode();

    const secondResult = await auth(provider, {
      serverUrl: url,
      authorizationCode: authCode,
    });

    await provider.stopCallbackServer();

    if (secondResult === "AUTHORIZED") {
      return true;
    }

    p.log.error(`Token exchange failed: ${secondResult}`);
    return false;
  } catch (err) {
    await provider.stopCallbackServer();
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Authentication failed: ${msg}`);
    return false;
  }
}

/**
 * Display config resolution status showing all config locations and which one was loaded.
 */
async function displayConfigResolution(loadedConfigPath: string): Promise<void> {
  const locations = await getConfigLocations();


  console.log("\nConfig Resolution:");
  console.log("─".repeat(80));
  console.log(
    `${"Priority".padEnd(10)} ${"Scope".padEnd(22)} ${"Path".padEnd(35)} ${"Status".padEnd(10)}`,
  );
  console.log("─".repeat(80));

  const priorities = { "project-local": 1, "user-project": 2, "user-global": 3 };

  for (const loc of locations) {
    const priority = priorities[loc.scope];
    const scopeLabel = getScopeLabel(loc.scope);

    // Truncate path if too long
    let displayPath = loc.path;
    if (displayPath.length > 33) {
      displayPath = `...${displayPath.slice(-30)}`;
    }

    let status: string;
    if (loc.path === loadedConfigPath) {
      status = "✓ LOADED";
    } else if (loc.exists) {
      status = "Found (skipped)";
    } else {
      status = "Not found";
    }

    console.log(
      `${String(priority).padEnd(10)} ${scopeLabel.padEnd(22)} ${displayPath.padEnd(35)} ${status}`,
    );
  }
  console.log("─".repeat(80));
  console.log();
}

export async function doctorCommand(configPath: string): Promise<void> {
  p.intro("RouterMCP Doctor - Checking configuration and authentication");

  // Display config resolution status
  await displayConfigResolution(configPath);

  const s = p.spinner();
  s.start("Loading configuration...");

  let config;
  try {
    config = await loadConfig(configPath);
    s.stop("Configuration loaded");
  } catch (err) {
    s.stop("Configuration error");
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Failed to load config: ${msg}`);
    p.outro("Doctor check failed");
    process.exit(1);
  }

  p.log.info(`Config file: ${configPath}`);
  p.log.info(`Servers configured: ${Object.keys(config.mcpServers).length}`);

  s.start("Probing servers for OAuth requirements...");

  const statuses: ServerOAuthStatus[] = [];
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    const status = await getServerOAuthStatus(name, serverConfig);
    statuses.push(status);
  }

  s.stop("Server probe complete");

  console.log("\nOAuth Status:");
  console.log("─".repeat(80));
  console.log(`${"Server".padEnd(20)} ${"URL".padEnd(40)} ${"Status".padEnd(15)}`);
  console.log("─".repeat(80));

  for (const status of statuses) {
    let statusText: string;
    let urlText = status.url || `(${status.transport})`;

    if (urlText.length > 38) {
      urlText = `${urlText.substring(0, 35)}...`;
    }

    switch (status.status) {
      case "ok":
        statusText = "Valid";
        break;
      case "needs-auth":
        statusText = "Needs auth";
        break;
      case "expired":
        statusText = "Expired";
        break;
      case "n/a":
        statusText = "No auth needed";
        break;
      case "unknown":
        statusText = "Unknown";
        break;
    }

    console.log(`${status.name.padEnd(20)} ${urlText.padEnd(40)} ${statusText.padEnd(15)}`);
  }
  console.log("─".repeat(80));

  const needsAuth = statuses.filter((s) => s.status === "needs-auth" || s.status === "expired");

  if (needsAuth.length === 0) {
    p.log.success("\nAll servers are ready!");
    p.outro("Doctor check complete");
    return;
  }

  p.log.warning(`\n${needsAuth.length} server(s) require authentication.`);

  const shouldAuth = await p.confirm({
    message: "Would you like to authenticate now?",
    initialValue: true,
  });

  if (p.isCancel(shouldAuth) || !shouldAuth) {
    p.outro("Doctor check complete (authentication skipped)");
    return;
  }

  for (const server of needsAuth) {
    if (!server.url) continue;

    p.log.step(`\nAuthenticating with ${server.name}...`);

    const success = await authenticateServer(server.name, server.url, server.oauthConfig);

    if (success) {
      p.log.success(`Authorization successful for ${server.name}!`);
    } else {
      p.log.error(`Authorization failed for ${server.name}`);
    }
  }

  const newStatuses: ServerOAuthStatus[] = [];
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    const status = await getServerOAuthStatus(name, serverConfig);
    newStatuses.push(status);
  }

  const stillNeedsAuth = newStatuses.filter(
    (s) => s.status === "needs-auth" || s.status === "expired",
  );

  if (stillNeedsAuth.length === 0) {
    p.log.success("\nAll servers are now authenticated!");
  } else {
    p.log.warning(`\n${stillNeedsAuth.length} server(s) still need authentication.`);
  }

  p.outro("Doctor check complete");
}
