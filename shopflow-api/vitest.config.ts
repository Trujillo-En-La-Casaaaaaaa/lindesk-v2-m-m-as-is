import { defineConfig } from "vitest/config";

/**
 * Vitest/Vite overwrite `process.env.BASE_URL` with their own base (`/`) while loading the config, so
 * the value the caller provided is captured here (before that happens) and handed to the tests under
 * an unambiguous name. `API_BASE_URL` already wins over `BASE_URL`.
 */
const callerApiBaseUrl = (process.env.API_BASE_URL ?? process.env.BASE_URL ?? "").trim();
const contractEnv: Record<string, string> =
  callerApiBaseUrl === "" ? {} : { SHOPFLOW_API_BASE_URL: callerApiBaseUrl };

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: contractEnv,
    // Integration/contract suites talk to real PostgreSQL and the notification provider.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
