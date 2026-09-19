import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { apiMock, handlers } from "./mocks/handlers";

/**
 * Vitest setup: jest-dom matchers plus an MSW server that answers the frozen `/api/*` contract.
 * Unknown requests are an error, which keeps the tests honest about the endpoints the SPA calls.
 */
export const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  apiMock.reset();
});

afterAll(() => {
  server.close();
});
