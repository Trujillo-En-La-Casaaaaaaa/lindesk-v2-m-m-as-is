import { describe, expect, it } from "vitest";
import {
  CONFIRMED_ORDER_STATUS,
  DORMANT_CANCELLED_ORDER_STATUS,
  SHIPPED_ORDER_STATUS,
  canShip,
  canTransition,
} from "../../../src/domain/order-status.js";
import type { OrderStatus } from "../../../src/domain/order-status.js";

describe("order status transitions", () => {
  it("writes exactly one status on creation and one transition target", () => {
    expect(CONFIRMED_ORDER_STATUS).toBe("CONFIRMED");
    expect(SHIPPED_ORDER_STATUS).toBe("SHIPPED");
  });

  it("allows only CONFIRMED -> SHIPPED", () => {
    expect(canTransition(CONFIRMED_ORDER_STATUS, SHIPPED_ORDER_STATUS)).toBe(true);
    expect(canTransition(SHIPPED_ORDER_STATUS, SHIPPED_ORDER_STATUS)).toBe(false);
    expect(canTransition(CONFIRMED_ORDER_STATUS, CONFIRMED_ORDER_STATUS)).toBe(false);
    expect(canTransition(SHIPPED_ORDER_STATUS, CONFIRMED_ORDER_STATUS)).toBe(false);
  });

  it("guards shipping to CONFIRMED orders only", () => {
    expect(canShip(CONFIRMED_ORDER_STATUS)).toBe(true);
    expect(canShip(SHIPPED_ORDER_STATUS)).toBe(false);
    expect(canShip(DORMANT_CANCELLED_ORDER_STATUS)).toBe(false);
  });

  it("has no cancellation transition anywhere (dormant value kept for data compatibility only)", () => {
    const statuses: OrderStatus[] = [
      CONFIRMED_ORDER_STATUS,
      SHIPPED_ORDER_STATUS,
      DORMANT_CANCELLED_ORDER_STATUS,
    ];
    for (const from of statuses) {
      expect(canTransition(from, DORMANT_CANCELLED_ORDER_STATUS)).toBe(false);
      expect(canShip(from)).toBe(from === CONFIRMED_ORDER_STATUS);
    }
    // The dormant value is still a valid member of the union (stored data compatibility).
    expect(statuses).toContain("CANCELLED");
  });
});
