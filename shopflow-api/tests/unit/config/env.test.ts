import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  DEFAULT_NOTIFICATION_RETRY_ATTEMPTS,
  DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
  DEFAULT_PORT,
  loadConfig,
} from "../../../src/config/env.js";

const required = {
  DATABASE_URL: "postgres://shopflow:shopflow@127.0.0.1:5433/shopflow",
  NOTIFICATION_PROVIDER_URL: "http://127.0.0.1:4010",
};

describe("configuration", () => {
  it("applies the documented defaults for the optional keys", () => {
    const config = loadConfig({ ...required });

    expect(config).toEqual({
      databaseUrl: required.DATABASE_URL,
      notificationProviderUrl: required.NOTIFICATION_PROVIDER_URL,
      port: DEFAULT_PORT,
      notificationRetryAttempts: DEFAULT_NOTIFICATION_RETRY_ATTEMPTS,
      outboxRelayIntervalMs: DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    });
    expect(DEFAULT_PORT).toBe(3001);
    expect(DEFAULT_NOTIFICATION_RETRY_ATTEMPTS).toBe(3);
    expect(DEFAULT_OUTBOX_RELAY_INTERVAL_MS).toBe(10_000);
  });

  it("reads every key from the environment and normalises the provider URL", () => {
    const config = loadConfig({
      ...required,
      NOTIFICATION_PROVIDER_URL: "http://notification-provider:4010/",
      PORT: "8080",
      NOTIFICATION_RETRY_ATTEMPTS: "5",
      OUTBOX_RELAY_INTERVAL_MS: "250",
    });

    expect(config.port).toBe(8080);
    expect(config.notificationRetryAttempts).toBe(5);
    expect(config.outboxRelayIntervalMs).toBe(250);
    expect(config.notificationProviderUrl).toBe("http://notification-provider:4010");
  });

  it("fails fast with a clear message when a required value is missing", () => {
    expect(() => loadConfig({ NOTIFICATION_PROVIDER_URL: "http://127.0.0.1:4010" })).toThrow(
      new ConfigurationError("Missing required environment variable DATABASE_URL"),
    );
    expect(() => loadConfig({ DATABASE_URL: required.DATABASE_URL })).toThrow(
      new ConfigurationError("Missing required environment variable NOTIFICATION_PROVIDER_URL"),
    );
    expect(() => loadConfig({ DATABASE_URL: "  ", NOTIFICATION_PROVIDER_URL: "x" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("rejects non-positive or non-numeric optional values instead of guessing", () => {
    expect(() => loadConfig({ ...required, PORT: "abc" })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ ...required, PORT: "0" })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ ...required, NOTIFICATION_RETRY_ATTEMPTS: "-1" })).toThrow(
      /Invalid NOTIFICATION_RETRY_ATTEMPTS/,
    );
    expect(() => loadConfig({ ...required, OUTBOX_RELAY_INTERVAL_MS: "1.5" })).toThrow(
      /Invalid OUTBOX_RELAY_INTERVAL_MS/,
    );
  });

  it("never contains a hardcoded default connection string", () => {
    const config = loadConfig({ ...required, DATABASE_URL: "postgres://other/db" });
    expect(config.databaseUrl).toBe("postgres://other/db");
  });
});
