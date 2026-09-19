import { describe, expect, it } from "vitest";
import { isValidOrderInput } from "../../../src/domain/order.js";

/**
 * Preserved rule from the monolith: `if (!customerEmail || quantity < 1) throw Invalid order`,
 * evaluated before any database access.
 */
describe("order input validation", () => {
  it("accepts a non-empty email with a quantity of at least one", () => {
    expect(
      isValidOrderInput({ productId: "prod-a", quantity: 1, customerEmail: "customer@example.com" }),
    ).toBe(true);
    expect(
      isValidOrderInput({ productId: "prod-a", quantity: 20, customerEmail: "customer@example.com" }),
    ).toBe(true);
  });

  it("rejects a missing or empty customer email", () => {
    expect(isValidOrderInput({ productId: "prod-a", quantity: 1, customerEmail: "" })).toBe(false);
  });

  it("rejects quantity zero and negative quantities", () => {
    expect(isValidOrderInput({ productId: "prod-a", quantity: 0, customerEmail: "a@b.c" })).toBe(false);
    expect(isValidOrderInput({ productId: "prod-a", quantity: -1, customerEmail: "a@b.c" })).toBe(false);
  });

  it("rejects an empty request exactly like the legacy `!customerEmail || quantity < 1` check", () => {
    expect(isValidOrderInput({ productId: "", quantity: 0, customerEmail: "" })).toBe(false);
  });

  it("accepts quantity 1 when stock is exactly 1 (boundary is enforced by the decrement, not here)", () => {
    expect(isValidOrderInput({ productId: "prod-b", quantity: 1, customerEmail: "a@b.c" })).toBe(true);
  });

  it("does not treat a non-numeric quantity as a validation error (legacy NaN path)", () => {
    // `Number("abc")` is NaN and `NaN < 1` is false, so the legacy rule lets it through; the failure
    // happens later in PostgreSQL as a 500. Inventing a 400 branch here would change the contract.
    expect(isValidOrderInput({ productId: "prod-a", quantity: Number("abc"), customerEmail: "a@b.c" })).toBe(
      true,
    );
  });

  it("does not validate the product id (product existence is the next check)", () => {
    expect(isValidOrderInput({ productId: "", quantity: 2, customerEmail: "a@b.c" })).toBe(true);
  });
});
