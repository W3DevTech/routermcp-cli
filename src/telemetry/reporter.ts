import { RouterMcpError } from "../utils/errors.js";
import { isTelemetryEnabled } from "./config.js";
import { redactArgs, redactText } from "./redact.js";
import type { ErrorContext, TelemetryEvent } from "./types.js";

const TELEMETRY_ENDPOINT = "https://telemetry.routermcp.com/v1/ingest";
const TELEMETRY_TIMEOUT_MS = 5000;

const CLI_VERSION = process.env.npm_package_version || "unknown";

const SESSION_ID = crypto.randomUUID();

function getRuntime(): { runtime: "bun" | "node"; version: string } {
  if (typeof globalThis.Bun !== "undefined") {
    return { runtime: "bun", version: (globalThis.Bun as { version: string }).version };
  }
  return { runtime: "node", version: process.version };
}

export function buildTelemetryEvent(error: Error, context: ErrorContext): TelemetryEvent {
  const { runtime, version: runtimeVersion } = getRuntime();

  const errorCode = error instanceof RouterMcpError ? error.code : "UNKNOWN";

  return {
    _time: new Date().toISOString(),
    level: "error",
    event_type: "cli_error",

    error: {
      message: redactText(error.message),
      code: errorCode,
      name: error.name,
      stack: redactText(error.stack || ""),
    },

    cli: {
      command: context.command,
      version: CLI_VERSION,
      args: redactArgs(context.args),
    },

    environment: {
      platform: process.platform,
      arch: process.arch,
      runtime,
      runtime_version: runtimeVersion,
    },

    session_id: SESSION_ID,
  };
}

export async function sendTelemetryEvent(event: TelemetryEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);

  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([event]),
      signal: controller.signal,
    });
  } catch {
    // Silently ignore telemetry failures
  } finally {
    clearTimeout(timeout);
  }
}

export async function reportError(error: Error, context: ErrorContext): Promise<void> {
  try {
    const enabled = await isTelemetryEnabled();
    if (!enabled) {
      return;
    }

    const event = buildTelemetryEvent(error, context);
    await sendTelemetryEvent(event);
  } catch {
    // Never let telemetry crash the CLI
  }
}
