/**
 * Runtime configuration, read once at startup.
 *
 * Every value comes from the environment; no host, credential or port is hardcoded. Missing required
 * values fail fast with a clear message instead of producing a half-working process.
 */

export interface AppConfig {
  /** PostgreSQL connection string (`DATABASE_URL`, required). */
  databaseUrl: string;
  /** HTTP port of this service (`PORT`, default 3001). */
  port: number;
  /** Base URL of the notification provider (`NOTIFICATION_PROVIDER_URL`, required). */
  notificationProviderUrl: string;
  /** In-request delivery attempts for the order-confirmation notification (`NOTIFICATION_RETRY_ATTEMPTS`, default 3). */
  notificationRetryAttempts: number;
  /** Outbox relay interval in milliseconds (`OUTBOX_RELAY_INTERVAL_MS`, default 10000). */
  outboxRelayIntervalMs: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export const DEFAULT_PORT = 3001;
export const DEFAULT_NOTIFICATION_RETRY_ATTEMPTS = 3;
export const DEFAULT_OUTBOX_RELAY_INTERVAL_MS = 10_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    port: positiveInteger(env, "PORT", DEFAULT_PORT),
    notificationProviderUrl: stripTrailingSlash(required(env, "NOTIFICATION_PROVIDER_URL")),
    notificationRetryAttempts: positiveInteger(
      env,
      "NOTIFICATION_RETRY_ATTEMPTS",
      DEFAULT_NOTIFICATION_RETRY_ATTEMPTS,
    ),
    outboxRelayIntervalMs: positiveInteger(
      env,
      "OUTBOX_RELAY_INTERVAL_MS",
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    ),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError(
      `Invalid ${name}: expected a positive integer but received "${raw}"`,
    );
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
