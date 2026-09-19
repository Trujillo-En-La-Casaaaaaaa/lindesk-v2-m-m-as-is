import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { createRequestHandler } from "./http-app.js";
import { NotificationStore } from "./store.js";

export const DEFAULT_PORT = 4010;
export const DEFAULT_LOG_PATH = "/data/notifications.jsonl";
export const DEFAULT_IDEMPOTENCY_PATH = "/data/notifications.idempotency.jsonl";

export interface ProviderConfig {
  port: number;
  logPath: string;
  idempotencyPath: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Environment of the emulator; every value has the contract's local default. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  return {
    port: positiveInteger(env, "PORT", DEFAULT_PORT),
    logPath: optionalString(env, "NOTIFICATION_LOG_PATH", DEFAULT_LOG_PATH),
    idempotencyPath: optionalString(
      env,
      "NOTIFICATION_IDEMPOTENCY_PATH",
      DEFAULT_IDEMPOTENCY_PATH,
    ),
  };
}

/** Create the store, load persisted records and start listening. */
export async function startProvider(
  config: ProviderConfig = loadConfig(),
): Promise<{ server: Server; store: NotificationStore; port: number }> {
  const store = new NotificationStore({
    logPath: config.logPath,
    idempotencyPath: config.idempotencyPath,
  });
  await store.init();

  const server = createServer(createRequestHandler(store));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  return { server, store, port };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, port } = await startProvider(config);
  console.log(`notification-provider listening on ${port} (log: ${config.logPath})`);

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`notification-provider received ${signal}, shutting down`);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", (signal) => shutdown(signal));
  process.on("SIGINT", (signal) => shutdown(signal));
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(
      `Invalid ${name}: expected a non-negative integer but received "${raw}"`,
    );
  }
  return value;
}

function optionalString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

const entryPoint = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entryPoint !== null && entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`notification-provider failed to start: ${message}`);
    process.exitCode = 1;
  });
}
