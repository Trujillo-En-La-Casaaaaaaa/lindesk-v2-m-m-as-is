import { describe, expect, it } from "vitest";
import { isDomainError } from "../../../src/domain/errors.js";
import { createHarness } from "../../support/harness.js";
import { sampleOrder, sampleProduct } from "../../support/fakes.js";

describe("ShipOrder use case", () => {
  it("performs the guarded CONFIRMED -> SHIPPED transition without touching stock or notifying", async () => {
    const harness = createHarness({
      products: [sampleProduct({ stock: 17 })],
      orders: [sampleOrder({ id: "order-1", status: "CONFIRMED" })],
    });

    const shipped = await harness.useCases.shipOrder.execute("order-1");

    expect(shipped.status).toBe("SHIPPED");
    expect(shipped.id).toBe("order-1");
    expect(harness.store.order("order-1")?.status).toBe("SHIPPED");
    expect(harness.orderRepository.calls.markShipped).toBe(1);
    // Shipping never changes stock and never emits a notification.
    expect(harness.store.product("prod-a")?.stock).toBe(17);
    expect(harness.notifications.records).toHaveLength(0);
    expect(harness.notifications.submissions).toHaveLength(0);
    expect(harness.store.intents).toHaveLength(0);
  });

  it("rejects a second ship call with Cannot ship order", async () => {
    const harness = createHarness({ orders: [sampleOrder({ id: "order-1", status: "SHIPPED" })] });

    await expect(harness.useCases.shipOrder.execute("order-1")).rejects.toSatisfy((error: unknown) => {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.kind).toBe("CONFLICT");
        expect(error.message).toBe("Cannot ship order");
      }
      return true;
    });

    expect(harness.store.order("order-1")?.status).toBe("SHIPPED");
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("rejects an unknown order with Cannot ship order (not 404)", async () => {
    const harness = createHarness();

    await expect(harness.useCases.shipOrder.execute("unknown")).rejects.toThrow("Cannot ship order");
    expect(harness.store.orders).toHaveLength(0);
  });

  it("rejects shipping a dormant CANCELLED order, keeping the legacy data value untouched", async () => {
    const harness = createHarness({ orders: [sampleOrder({ id: "order-1", status: "CANCELLED" })] });

    await expect(harness.useCases.shipOrder.execute("order-1")).rejects.toThrow("Cannot ship order");
    expect(harness.store.order("order-1")?.status).toBe("CANCELLED");
  });
});
