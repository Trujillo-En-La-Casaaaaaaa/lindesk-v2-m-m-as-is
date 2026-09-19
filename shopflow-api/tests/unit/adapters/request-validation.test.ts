import { describe, expect, it } from "vitest";
import { parseCreateOrderBody, parsePathId } from "../../../src/adapters/inbound/http/request-validation.js";

describe("inbound request coercion (preserved legacy parsing)", () => {
  it("coerces the body exactly like the legacy controller", () => {
    expect(parseCreateOrderBody({ productId: "prod-a", quantity: 2, customerEmail: "a@b.c" })).toEqual({
      productId: "prod-a",
      quantity: 2,
      customerEmail: "a@b.c",
    });
    expect(parseCreateOrderBody({ productId: 7, quantity: "3", customerEmail: 42 })).toEqual({
      productId: "7",
      quantity: 3,
      customerEmail: "42",
    });
  });

  it("defaults missing fields to an empty product id, quantity 0 and an empty email", () => {
    expect(parseCreateOrderBody(undefined)).toEqual({
      productId: "",
      quantity: 0,
      customerEmail: "",
    });
    expect(parseCreateOrderBody({})).toEqual({ productId: "", quantity: 0, customerEmail: "" });
  });

  it("keeps the non-numeric quantity coercion that leads to the legacy 500 path", () => {
    const parsed = parseCreateOrderBody({ productId: "prod-a", quantity: "abc", customerEmail: "a@b.c" });
    expect(Number.isNaN(parsed.quantity)).toBe(true);
    expect(parsed.quantity < 1).toBe(false);
  });

  it("coerces null and false without inventing validation", () => {
    expect(parseCreateOrderBody({ productId: null, quantity: null, customerEmail: null })).toEqual({
      productId: "",
      quantity: 0,
      customerEmail: "",
    });
    expect(parseCreateOrderBody({ productId: false, quantity: false, customerEmail: false })).toEqual({
      productId: "false",
      quantity: 0,
      customerEmail: "false",
    });
  });

  it("treats path ids as opaque strings", () => {
    expect(parsePathId("prod-a")).toBe("prod-a");
    expect(parsePathId("weird id; --")).toBe("weird id; --");
    expect(parsePathId("")).toBe("");
    expect(parsePathId(undefined)).toBe("");
  });
});
