import { resolveConfigFromPath } from "../config/loader.js";
import { Aggregator } from "../core/aggregator.js";
import { UpstreamManager } from "../core/upstream.js";
import { OpenApiHandler } from "../openapi/index.js";
import { ConfigError } from "../utils/errors.js";

export interface ToolsCommandOptions {
  config?: string;
  json: boolean;
  verbose: boolean;
}

interface ToolEntry {
  name: string;
  server: string;
  description?: string;
}

export async function toolsCommand(options: ToolsCommandOptions): Promise<void> {
  const verbose = options.verbose;

  const { config } = await resolveConfigFromPath(options.config).catch((err) => {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  });

  const concurrency = config.discovery_concurrency ?? 5;
  const manager = new UpstreamManager(config, verbose);
  await manager.discoverAll(concurrency);

  const aggregator = new Aggregator(manager);
  aggregator.refresh();
  const toolsMap = aggregator.getToolsMap();

  let openApiHandler: OpenApiHandler | null = null;
  if (config.openApiServers) {
    openApiHandler = new OpenApiHandler(config.openApiServers, verbose);
    await openApiHandler.initialize(false);
    for (const [name, entry] of openApiHandler.getToolsMap()) {
      if (toolsMap.has(name)) {
        if (verbose) {
          console.error(`[tools] Skipping OpenAPI tool "${name}" (collides with MCP tool)`);
        }
        continue;
      }
      toolsMap.set(name, entry);
    }
  }

  await manager.disconnectAll();

  const entries: ToolEntry[] = [];
  for (const [name, { tool, serverName }] of toolsMap) {
    entries.push({
      name,
      server: serverName,
      description: tool.description,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(entries, null, 0));
    return;
  }

  if (entries.length === 0) {
    console.log("No tools found.");
    return;
  }

  const maxServer = Math.max(8, ...entries.map((e) => e.server.length));
  const maxName = Math.max(4, ...entries.map((e) => e.name.length));
  const descWidth = 60;
  const serverPad = Math.min(maxServer, 24);
  const namePad = Math.min(maxName, 36);

  const header = ["SERVER".padEnd(serverPad), "NAME".padEnd(namePad), "DESCRIPTION"].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const e of entries) {
    const server = e.server.slice(0, serverPad);
    const name = e.name.slice(0, namePad);
    const desc = (e.description ?? "").replace(/\s+/g, " ").slice(0, descWidth);
    console.log([server.padEnd(serverPad), name.padEnd(namePad), desc].join("  "));
  }
}
