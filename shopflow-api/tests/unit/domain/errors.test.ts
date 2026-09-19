import { describe, expect, it } from "vitest";
import {
  DomainError,
  cannotShipOrder,
  insufficientStock,
  invalidOrder,
  isDomainError,
  notFound,
  productNotFound,
} from "../../../src/domain/errors.js";
import { mapErrorToResponse } from "../../../src/adapters/inbound/http/error-mapping.js";

describe("domain errors", () => {
  it("preserves the four customer-visible messages with their semantic kinds", () => {
    expect(invalidOrder().message).toBe("Invalid order");
    expect(invalidOrder().kind).toBe("VALIDATION");
    expect(productNotFound().message).toBe("Product not found");
    expect(productNotFound().kind).toBe("NOT_FOUND");
    expect(insufficientStock().message).toBe("Insufficient stock");
    expect(insufficientStock().kind).toBe("CONFLICT");
    expect(cannotShipOrder().message).toBe("Cannot ship order");
    expect(cannotShipOrder().kind).toBe("CONFLICT");
    expect(notFound().message).toBe("Not found");
    expect(notFound().kind).toBe("NOT_FOUND");
  });

  it("maps kinds to the frozen status codes", () => {
    expect(mapErrorToResponse(invalidOrder()).status).toBe(400);
    expect(mapErrorToResponse(productNotFound()).status).toBe(404);
    expect(mapErrorToResponse(insufficientStock()).status).toBe(400);
    expect(mapErrorToResponse(cannotShipOrder()).status).toBe(400);
    expect(mapErrorToResponse(new DomainError("UNEXPECTED", "boom")).status).toBe(500);
  });

  it("keeps the message in the error body", () => {
    expect(mapErrorToResponse(invalidOrder()).body).toEqual({ error: "Invalid order" });
    expect(mapErrorToResponse(productNotFound()).body).toEqual({ error: "Product not found" });
    expect(mapErrorToResponse(insufficientStock()).body).toEqual({ error: "Insufficient stock" });
    expect(mapErrorToResponse(cannotShipOrder()).body).toEqual({ error: "Cannot ship order" });
  });

  it("falls back to 500 Internal error for unknown throwables without a message", () => {
    expect(mapErrorToResponse(undefined).body).toEqual({ error: "Internal error" });
    expect(mapErrorToResponse("boom").body).toEqual({ error: "Internal error" });
    expect(mapErrorToResponse(new Error("")).body).toEqual({ error: "Internal error" });
  });

  it("is recognised by the type guard", () => {
    expect(isDomainError(invalidOrder())).toBe(true);
    expect(isDomainError(new Error("Invalid order"))).toBe(false);
  });
});
