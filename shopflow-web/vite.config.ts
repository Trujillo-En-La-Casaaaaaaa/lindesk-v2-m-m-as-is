import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Build configuration for the ShopFlow SPA.
 *
 * `vite build` emits one static asset set in `dist/` (nothing is rendered on the server); the Vitest
 * configuration lives here as well so a single toolchain serves build and tests.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setupTests.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
