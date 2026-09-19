import { describe, expect, it } from "vitest";
import { isDomainError } from "../../../src/domain/errors.js";
import { createHarness } from "../../support/harness.js";
import { sampleOrder, sampleProduct } from "../../support/fakes.js";

describe("read use cases", () => {
  it("ListProducts returns the catalog exactly as the repository orders it", async () => {
    const harness = createHarness({
      products: [
        sampleProduct({ id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 }),
        sampleProduct({ id: "prod-b", name: "Product B", priceCents: 999, stock: 10 }),
      ],
    });

    const products = await harness.useCases.listProducts.execute();

    expect(products).toEqual([
      { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
      { id: "prod-b", name: "Product B", priceCents: 999, stock: 10 },
    ]);
    expect(harness.productRepository.calls.list).toBe(1);
  });

  it("GetProduct returns the product and a 404-mapped error when it is missing", async () => {
    const harness = createHarness({ products: [sampleProduct({ id: "prod-a" })] });

    await expect(harness.useCases.getProduct.execute("prod-a")).resolves.toEqual({
      id: "prod-a",
      name: "Product A",
      priceCents: 1999,
      stock: 20,
    });

    await expect(harness.useCases.getProduct.execute("prod-missing")).rejects.toSatisfy(
      (error: unknown) => {
        expect(isDomainError(error)).toBe(true);
        if (isDomainError(error)) {
          expect(error.kind).toBe("NOT_FOUND");
          expect(error.message).toBe("Not found");
        }
        return true;
      },
    );
  });

  it("GetOrder returns the order with every key present and nulls for the dormant columns", async () => {
    const harness = createHarness({ orders: [sampleOrder({ id: "order-1" })] });

    const order = await harness.useCases.getOrder.execute("order-1");

    expect(order).toEqual(sampleOrder({ id: "order-1" }));
    expect(Object.keys(order).sort()).toEqual([
      "cancellationReason",
      "cancelledAt",
      "createdAt",
      "customerEmail",
      "id",
      "productId",
      "quantity",
      "status",
      "totalCents",
    ]);

    await expect(harness.useCases.getOrder.execute("unknown")).rejects.toThrow("Not found");
  });

  it("ListNotifications reads through the notification port and keeps insertion order", async () => {
    const harness = createHarness({ products: [sampleProduct({ stock: 20 })] });

    await harness.useCases.createOrder.execute({
      productId: "prod-a",
      quantity: 1,
      customerEmail: "first@example.com",
    });
    await harness.useCases.createOrder.execute({
      productId: "prod-a",
      quantity: 1,
      customerEmail: "second@example.com",
    });

    const notifications = await harness.useCases.listNotifications.execute();

    expect(notifications).toHaveLength(2);
    expect(notifications.map((record) => record.payload.customerEmail)).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
    expect(notifications.map((record) => record.orderId)).toEqual(
      harness.store.orders.map((order) => order.id),
    );
    expect(notifications[0]).toMatchObject({
      type: "ORDER_CONFIRMATION",
      createdAt: "2026-09-17T10:15:00.000Z",
    });
  });
});
