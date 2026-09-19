import { describe, expect, it } from "vitest";
import { computeTotalCents } from "../../../src/domain/pricing.js";

describe("pricing rule", () => {
  it("is the product price at order time multiplied by the quantity", () => {
    expect(computeTotalCents(1999, 2)).toBe(3998);
    expect(computeTotalCents(999, 10)).toBe(9990);
    expect(computeTotalCents(1999, 1)).toBe(1999);
  });

  it("stays integer cents with no currency, tax, discount or rounding", () => {
    expect(Number.isInteger(computeTotalCents(1999, 3))).toBe(true);
    expect(computeTotalCents(1, 3)).toBe(3);
    expect(computeTotalCents(0, 5)).toBe(0);
  });

  it("uses the stored price snapshot, so a later catalog change cannot alter an existing order", () => {
    const priceAtOrderTime = 1999;
    const totalCents = computeTotalCents(priceAtOrderTime, 2);
    const priceAfterCatalogChange = 2500;
    expect(totalCents).toBe(3998);
    expect(computeTotalCents(priceAfterCatalogChange, 2)).not.toBe(totalCents);
  });
});
