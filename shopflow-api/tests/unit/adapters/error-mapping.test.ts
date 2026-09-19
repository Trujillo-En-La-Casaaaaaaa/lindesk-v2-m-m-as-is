import { describe, expect, it } from "vitest";
import { mapErrorToResponse } from "../../../src/adapters/inbound/http/error-mapping.js";
import { DomainError } from "../../../src/domain/errors.js";

describe("HTTP error mapping", () => {
  it("maps VALIDATION/NOT_FOUND/CONFLICT/UNEXPECTED to 400/404/400/500", () => {
    expect(mapErrorToResponse(new DomainError("VALIDATION", "Invalid order"))).toEqual({
      status: 400,
      body: { error: "Invalid order" },
    });
    expect(mapErrorToResponse(new DomainError("NOT_FOUND", "Not found"))).toEqual({
      status: 404,
      body: { error: "Not found" },
    });
    expect(mapErrorToResponse(new DomainError("CONFLICT", "Insufficient stock"))).toEqual({
      status: 400,
      body: { error: "Insufficient stock" },
    });
    expect(mapErrorToResponse(new DomainError("UNEXPECTED", "boom"))).toEqual({
      status: 500,
      body: { error: "boom" },
    });
  });

  it("keeps the legacy `status = error.status ?? 500` behaviour for driver-style errors", () => {
    const driverError = Object.assign(new Error('invalid input syntax for type integer: "NaN"'), {
      severity: "ERROR",
      code: "22P02",
    });
    expect(mapErrorToResponse(driverError)).toEqual({
      status: 500,
      body: { error: 'invalid input syntax for type integer: "NaN"' },
    });

    const httpError = Object.assign(new Error("request entity too large"), { status: 413 });
    expect(mapErrorToResponse(httpError)).toEqual({
      status: 413,
      body: { error: "request entity too large" },
    });
  });

  it("falls back to Internal error without a message", () => {
    expect(mapErrorToResponse(undefined)).toEqual({ status: 500, body: { error: "Internal error" } });
    expect(mapErrorToResponse({})).toEqual({ status: 500, body: { error: "Internal error" } });
    expect(mapErrorToResponse(42)).toEqual({ status: 500, body: { error: "Internal error" } });
  });
});
