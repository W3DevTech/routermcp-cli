/**
 * Telemetry event sent to Axiom (follows Axiom ingestion format).
 */
export interface TelemetryEvent {
  _time: string;
  level: "error";
  event_type: "cli_error";

  error: {
    message: string;
    code: string;
    name: string;
    stack: string;
  };

  cli: {
    command: string;
    version: string;
    args: string[];
  };

  environment: {
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    runtime: "bun" | "node";
    runtime_version: string;
  };

  session_id: string;
}

export interface ErrorContext {
  command: string;
  args: string[];
}

export interface TelemetryConfig {
  enabled: boolean;
}

export interface UserConfig {
  telemetry?: TelemetryConfig;
}
