import { describe, expect, it } from "vitest";
import { isDomainError } from "../../../src/domain/errors.js";
import { createHarness } from "../../support/harness.js";
import { sampleIntent, sampleProduct } from "../../support/fakes.js";

const customerEmail = "customer@example.com";

function expectDomainError(error: unknown, kind: string, message: string): void {
  expect(isDomainError(error)).toBe(true);
  if (!isDomainError(error)) {
    throw new Error("expected a DomainError");
  }
  expect(error.kind).toBe(kind);
  expect(error.message).toBe(message);
}

describe("CreateOrder use case", () => {
  it("creates a CONFIRMED order priced from the product and delivers exactly one notification", async () => {
    const harness = createHarness({ products: [sampleProduct({ stock: 20, priceCents: 1999 })] });

    const order = await harness.useCases.createOrder.execute({
      productId: "prod-a",
      quantity: 2,
      customerEmail,
    });

    expect(order).toEqual({
      id: "id-1",
      customerEmail,
      status: "CONFIRMED",
      productId: "prod-a",
      quantity: 2,
      totalCents: 3998,
      createdAt: "2026-09-17T10:15:00.000Z",
      cancelledAt: null,
      cancellationReason: null,
    });

    // One transaction, one decrement, one order row, one intent.
    expect(harness.unitOfWork.runs).toBe(1);
    expect(harness.store.orders).toHaveLength(1);
    expect(harness.store.product("prod-a")?.stock).toBe(18);
    expect(harness.store.intents).toHaveLength(1);

    const intent = harness.store.intents[0];
    expect(intent?.type).toBe("ORDER_CONFIRMATION");
    expect(intent?.orderId).toBe(order.id);
    expect(intent?.payload).toEqual({ customerEmail, orderId: order.id });
    expect(intent?.status).toBe("SENT");
    expect(intent?.attempts).toBe(0);
    expect(intent?.sentAt).toBe("2026-09-17T10:15:00.000Z");

    // Delivered in-request before the caller got the order, using the intent id as idempotency key.
    expect(harness.notifications.submissions).toHaveLength(1);
    expect(harness.notifications.submissions[0]).toEqual({
      idempotencyKey: intent?.id,
      type: "ORDER_CONFIRMATION",
      orderId: order.id,
      payload: { customerEmail, orderId: order.id },
    });
    expect(harness.notifications.records).toHaveLength(1);
    expect(harness.outbox.calls.markSent).toBe(1);
  });

  it("rejects an invalid order before any database access", async () => {
    const harness = createHarness({ products: [sampleProduct()] });

    await expect(
      harness.useCases.createOrder.execute({ productId: "prod-a", quantity: 1, customerEmail: "" }),
    ).rejects.toSatisfy((error: unknown) => {
      expectDomainError(error, "VALIDATION", "Invalid order");
      return true;
    });

    expect(harness.productRepository.calls.getById).toBe(0);
    expect(harness.unitOfWork.runs).toBe(0);
    expect(harness.store.orders).toHaveLength(0);
    expect(harness.store.intents).toHaveLength(0);
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("rejects quantity zero and negative quantities with the same message", async () => {
    const harness = createHarness({ products: [sampleProduct()] });

    for (const quantity of [0, -1, -10]) {
      await expect(
        harness.useCases.createOrder.execute({ productId: "prod-a", quantity, customerEmail }),
      ).rejects.toThrow("Invalid order");
    }

    expect(harness.unitOfWork.runs).toBe(0);
    expect(harness.store.product("prod-a")?.stock).toBe(20);
  });

  it("fails with Product not found and leaves no trace", async () => {
    const harness = createHarness({ products: [sampleProduct()] });

    await expect(
      harness.useCases.createOrder.execute({ productId: "prod-missing", quantity: 1, customerEmail }),
    ).rejects.toSatisfy((error: unknown) => {
      expectDomainError(error, "NOT_FOUND", "Product not found");
      return true;
    });

    expect(harness.store.orders).toHaveLength(0);
    expect(harness.store.intents).toHaveLength(0);
    expect(harness.store.product("prod-a")?.stock).toBe(20);
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("fails with Insufficient stock and writes nothing (transaction rolled back)", async () => {
    const harness = createHarness({ products: [sampleProduct({ stock: 1 })] });

    await expect(
      harness.useCases.createOrder.execute({ productId: "prod-a", quantity: 2, customerEmail }),
    ).rejects.toSatisfy((error: unknown) => {
      expectDomainError(error, "CONFLICT", "Insufficient stock");
      return true;
    });

    expect(harness.store.product("prod-a")?.stock).toBe(1);
    expect(harness.store.orders).toHaveLength(0);
    expect(harness.store.intents).toHaveLength(0);
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("succeeds when stock is exactly the ordered quantity and leaves zero stock", async () => {
    const harness = createHarness({ products: [sampleProduct({ stock: 5 })] });

    const order = await harness.useCases.createOrder.execute({
      productId: "prod-a",
      quantity: 5,
      customerEmail,
    });

    expect(order.totalCents).toBe(9995);
    expect(harness.store.product("prod-a")?.stock).toBe(0);
    expect(harness.notifications.records).toHaveLength(1);
  });

  it("retries a transient delivery failure with 100 ms / 300 ms backoff and still succeeds", async () => {
    const delays: number[] = [];
    const harness = createHarness({
      products: [sampleProduct()],
      notificationRetryAttempts: 3,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    harness.notifications.failuresRemaining = 1;

    const order = await harness.useCases.createOrder.execute({
      productId: "prod-a",
      quantity: 1,
      customerEmail,
    });

    expect(delays).toEqual([100]);
    expect(harness.notifications.submissions).toHaveLength(2);
    expect(harness.notifications.records).toHaveLength(1);
    expect(harness.store.intents[0]?.status).toBe("SENT");
    expect(harness.store.intents[0]?.attempts).toBe(1);
    expect(harness.store.order(order.id)?.status).toBe("CONFIRMED");
  });

  it("keeps the order committed and the intent PENDING when every delivery attempt fails", async () => {
    const delays: number[] = [];
    const harness = createHarness({
      products: [sampleProduct({ stock: 20 })],
      notificationRetryAttempts: 3,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    harness.notifications.failuresRemaining = Number.POSITIVE_INFINITY;
    harness.notifications.failure = new Error("notification provider unavailable");

    await expect(
      harness.useCases.createOrder.execute({ productId: "prod-a", quantity: 2, customerEmail }),
    ).rejects.toThrow("notification provider unavailable");

    // Post-commit failure semantics preserved: the order and the stock change stay committed ...
    expect(harness.store.orders).toHaveLength(1);
    expect(harness.store.product("prod-a")?.stock).toBe(18);
    // ... while the intent stays PENDING with its attempt count for the relay to retry.
    expect(delays).toEqual([100, 300]);
    expect(harness.notifications.submissions).toHaveLength(3);
    expect(harness.notifications.records).toHaveLength(0);
    expect(harness.store.intents).toHaveLength(1);
    expect(harness.store.intents[0]?.status).toBe("PENDING");
    expect(harness.store.intents[0]?.attempts).toBe(3);
    expect(harness.store.intents[0]?.sentAt).toBeNull();
    expect(harness.outbox.calls.markSent).toBe(0);
  });

  it("stops retrying at NOTIFICATION_RETRY_ATTEMPTS", async () => {
    const harness = createHarness({
      products: [sampleProduct()],
      notificationRetryAttempts: 1,
      sleep: async () => {
        throw new Error("no backoff expected for a single attempt");
      },
    });
    harness.notifications.failuresRemaining = Number.POSITIVE_INFINITY;

    await expect(
      harness.useCases.createOrder.execute({ productId: "prod-a", quantity: 1, customerEmail }),
    ).rejects.toThrow("notification provider unavailable");

    expect(harness.notifications.submissions).toHaveLength(1);
    expect(harness.store.intents[0]?.attempts).toBe(1);
    expect(harness.store.intents[0]?.status).toBe("PENDING");
  });

  it("rolls the transaction back when the outbox insert is refused, so no order survives without its intent", async () => {
    // The unique `(order_id, type)` index of the real schema is modelled by the outbox double: the
    // intent for the generated order id already exists, so the staged insert fails after the order
    // insert and before the commit.
    const harness = createHarness({
      products: [sampleProduct()],
      intents: [sampleIntent({ id: "id-99", orderId: "id-1", type: "ORDER_CONFIRMATION" })],
    });

    await expect(
      harness.useCases.createOrder.execute({ productId: "prod-a", quantity: 1, customerEmail }),
    ).rejects.toThrow("duplicate notification intent");

    expect(harness.store.orders).toHaveLength(0);
    expect(harness.store.intents).toHaveLength(1);
    expect(harness.store.intents[0]?.id).toBe("id-99");
    expect(harness.store.product("prod-a")?.stock).toBe(20);
    expect(harness.notifications.records).toHaveLength(0);
  });
});
