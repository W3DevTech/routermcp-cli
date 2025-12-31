import * as p from "@clack/prompts";
import { isTelemetryEnabled, setTelemetryEnabled, getConfigPath } from "../telemetry/index.js";

export type TelemetryAction = "enable" | "disable" | "status";

async function telemetryEnableCommand(): Promise<void> {
  await setTelemetryEnabled(true);
  p.log.success("Telemetry enabled");
  console.error(`Configuration saved to: ${getConfigPath()}`);
}

async function telemetryDisableCommand(): Promise<void> {
  await setTelemetryEnabled(false);
  p.log.success("Telemetry disabled");
  console.error(`Configuration saved to: ${getConfigPath()}`);
}

async function telemetryStatusCommand(): Promise<void> {
  const enabled = await isTelemetryEnabled();

  console.log();
  console.log("Telemetry Status");
  console.log("─".repeat(40));
  console.log(`  Enabled: ${enabled ? "Yes" : "No"}`);
  console.log(`  Config:  ${getConfigPath()}`);
  console.log();

  if (enabled) {
    console.log("Telemetry sends anonymous error reports to help improve RouterMCP.");
    console.log("No config contents are collected. CLI arguments and stack traces are sent.");
    console.log();
    console.log("To disable: routermcp telemetry disable");
  } else {
    console.log("Telemetry is currently disabled.");
    console.log("To enable: routermcp telemetry enable");
  }
  console.log();
}

export async function telemetryCommand(action?: TelemetryAction): Promise<void> {
  if (!action) {
    await telemetryStatusCommand();
    return;
  }

  switch (action) {
    case "enable":
      await telemetryEnableCommand();
      break;
    case "disable":
      await telemetryDisableCommand();
      break;
    case "status":
      await telemetryStatusCommand();
      break;
    default:
      console.error(`Unknown telemetry action: ${action}`);
      console.error("Usage: routermcp telemetry <enable|disable|status>");
      process.exit(1);
  }
}
