import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isDomainError } from "../../../src/domain/errors.js";
import {
  DATABASE_SKIP_MESSAGE,
  TestDatabase,
  resolveTestDatabaseUrl,
} from "../../support/database.js";
import { FixedIdGenerator, createPostgresHarness, uniqueId } from "../../support/postgres-harness.js";
import type { PostgresHarness } from "../../support/postgres-harness.js";

const databaseUrl = resolveTestDatabaseUrl();
if (databaseUrl === null) {
  console.warn(DATABASE_SKIP_MESSAGE);
}
const describeWithDatabase = describe.skipIf(databaseUrl === null);

const productId = uniqueId("it-inventory");
const customerEmail = "inventory@example.com";
const product = { id: productId, name: "Integration Product", priceCents: 1999, stock: 5 };

describeWithDatabase("PostgreSQL inventory decrement and transaction atomicity", () => {
  let database: TestDatabase;
  let harness: PostgresHarness;

  beforeAll(async () => {
    database = await TestDatabase.open(databaseUrl as string);
    harness = createPostgresHarness(database.pool);
    await database.insertProduct(product);
  });

  afterAll(async () => {
    await database.removeTestData([productId]);
    await database.close();
  });

  beforeEach(async () => {
    await database.removeTestData([productId]);
    await database.insertProduct(product);
    harness.notifications.records.length = 0;
    harness.notifications.submissions.length = 0;
  });

  it("decrements stock by the ordered quantity and persists the mapped order and intent", async () => {
    const order = await harness.useCases.createOrder.execute({
      productId,
      quantity: 2,
      customerEmail,
    });

    expect(order).toMatchObject({
      customerEmail,
      status: "CONFIRMED",
      productId,
      quantity: 2,
      totalCents: 3998,
      cancelledAt: null,
      cancellationReason: null,
    });
    expect(order.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(order.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Stock decreased by exactly the ordered quantity.
    const storedProduct = await database.readProduct(productId);
    expect(storedProduct?.stock).toBe(3);

    // Row-level evidence: the order row carries the price snapshot and the dormant columns stay empty.
    const orderRow = await database.readOrder(order.id);
    expect(orderRow).toMatchObject({
      customer_email: customerEmail,
      status: "CONFIRMED",
      product_id: productId,
      quantity: 2,
      total_cents: 3998,
      cancelled_at: null,
      cancellation_reason: null,
    });
    // Legacy row-mapper detail, preserved on purpose: `mapOrderRow` builds the timestamp with
    // `new Date(String(row.created_at))`, and `String(Date)` drops the milliseconds, so the mapped
    // value is always whole seconds (`...:56.000Z`). The stored instant itself keeps microseconds.
    expect(order.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(orderRow?.created_at.toISOString().slice(0, 19)).toBe(order.createdAt.slice(0, 19));
    expect(Math.abs((orderRow as { created_at: Date }).created_at.getTime() - Date.parse(order.createdAt))).toBeLessThan(1000);

    // Exactly one delivery intent, marked SENT by the in-request delivery.
    const intents = await database.readOutboxForOrder(order.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      type: "ORDER_CONFIRMATION",
      status: "SENT",
      attempts: 0,
      payload: { customerEmail, orderId: order.id },
    });
    expect(intents[0]?.sent_at).not.toBeNull();
    expect(harness.notifications.recordsFor(order.id)).toHaveLength(1);

    // The order is readable through the use case with every key present.
    const readBack = await harness.useCases.getOrder.execute(order.id);
    expect(Object.keys(readBack).sort()).toEqual([
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
    expect(readBack).toEqual(order);
  });

  it("rejects an insufficient-stock order without changing either table", async () => {
    await expect(
      harness.useCases.createOrder.execute({ productId, quantity: 6, customerEmail }),
    ).rejects.toThrow("Insufficient stock");

    expect((await database.readProduct(productId))?.stock).toBe(5);
    expect(await database.readOrdersForProduct(productId)).toHaveLength(0);
    expect(
      await database.countOrders(
        "SELECT COUNT(*)::text AS count FROM notification_outbox o JOIN orders r ON r.id = o.order_id WHERE r.product_id = $1",
        [productId],
      ),
    ).toBe(0);
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("rejects an unknown product and rejects empty ids with the preserved messages", async () => {
    await expect(
      harness.useCases.createOrder.execute({ productId: uniqueId("it-missing"), quantity: 1, customerEmail }),
    ).rejects.toThrow("Product not found");
    await expect(
      harness.useCases.createOrder.execute({ productId: "", quantity: 1, customerEmail }),
    ).rejects.toThrow("Product not found");
    await expect(harness.useCases.getProduct.execute("")).rejects.toThrow("Not found");
    await expect(harness.useCases.getProduct.execute("weird id; --")).rejects.toThrow("Not found");
    await expect(harness.useCases.getOrder.execute("weird id; --")).rejects.toThrow("Not found");

    expect(await harness.productRepository.getById("")).toBeNull();
    expect(await harness.orderRepository.getById("weird id; --")).toBeNull();
    expect((await database.readProduct(productId))?.stock).toBe(5);
  });

  it("rolls the stock decrement back when the order insert fails inside the transaction", async () => {
    // The generated order id already exists, so the INSERT fails after the successful decrement: the
    // whole transaction must roll back, leaving stock untouched and no new row anywhere.
    const collidingOrderId = uniqueId("it-collision");
    const failingHarness = createPostgresHarness(database.pool, {
      ids: new FixedIdGenerator([collidingOrderId, uniqueId("it-collision-intent")]),
    });
    await database.pool.query(
      `INSERT INTO orders (id, customer_email, status, product_id, quantity, total_cents, created_at)
       VALUES ($1,$2,'CONFIRMED',$3,1,1999,NOW())`,
      [collidingOrderId, "pre-existing@example.com", productId],
    );

    await expect(
      failingHarness.useCases.createOrder.execute({ productId, quantity: 2, customerEmail }),
    ).rejects.toThrow(/duplicate key value/);

    expect((await database.readProduct(productId))?.stock).toBe(5);
    const orders = await database.readOrdersForProduct(productId);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.id).toBe(collidingOrderId);
    expect(await database.readOutboxForOrder(collidingOrderId)).toHaveLength(0);
    expect(failingHarness.notifications.records).toHaveLength(0);
  });

  it("keeps exactly one delivery intent per order through the unique (order_id, type) index", async () => {
    const order = await harness.useCases.createOrder.execute({
      productId,
      quantity: 1,
      customerEmail,
    });

    await expect(
      database.pool.query(
        `INSERT INTO notification_outbox (id, order_id, type, payload, status, attempts, created_at)
         VALUES ($1,$2,'ORDER_CONFIRMATION','{}'::jsonb,'PENDING',0,NOW())`,
        [uniqueId("it-duplicate-intent"), order.id],
      ),
    ).rejects.toThrow(/duplicate key value/);

    expect(await database.readOutboxForOrder(order.id)).toHaveLength(1);
  });

  it("ships a CONFIRMED order without touching stock and without emitting a notification", async () => {
    const order = await harness.useCases.createOrder.execute({
      productId,
      quantity: 2,
      customerEmail,
    });
    const stockAfterOrder = (await database.readProduct(productId))?.stock;

    const shipped = await harness.useCases.shipOrder.execute(order.id);
    expect(shipped.status).toBe("SHIPPED");
    expect((await database.readOrder(order.id))?.status).toBe("SHIPPED");

    // No stock change, no second intent, no second notification.
    expect((await database.readProduct(productId))?.stock).toBe(stockAfterOrder);
    expect(await database.readOutboxForOrder(order.id)).toHaveLength(1);
    expect(harness.notifications.recordsFor(order.id)).toHaveLength(1);

    await expect(harness.useCases.shipOrder.execute(order.id)).rejects.toThrow("Cannot ship order");
    await expect(harness.useCases.shipOrder.execute(uniqueId("it-unknown"))).rejects.toThrow(
      "Cannot ship order",
    );
    expect((await database.readOrder(order.id))?.status).toBe("SHIPPED");
  });

  it("lists products ordered by id, including the rows of this suite", async () => {
    const products = await harness.useCases.listProducts.execute();
    const ids = products.map((candidate) => candidate.id);
    expect([...ids].sort()).toEqual(ids);
    expect(products.find((candidate) => candidate.id === productId)).toEqual({
      id: productId,
      name: product.name,
      priceCents: product.priceCents,
      stock: 5,
    });
  });

  it("surfaces driver failures as non-domain errors, so the HTTP adapter answers 500", async () => {
    // A non-numeric quantity is the preserved legacy path: the validation rule accepts it and the
    // database refuses the statement, leaving nothing behind.
    const error = await harness.useCases.createOrder
      .execute({ productId, quantity: Number("abc"), customerEmail })
      .catch((caught: unknown) => caught);

    expect(isDomainError(error)).toBe(false);
    expect((error as Error).message).toMatch(/invalid input syntax|NaN/);
    expect((await database.readProduct(productId))?.stock).toBe(5);
    expect(await database.readOrdersForProduct(productId)).toHaveLength(0);
  });
});
