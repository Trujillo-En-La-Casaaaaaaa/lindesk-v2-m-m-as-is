import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_SKIP_MESSAGE,
  TestDatabase,
  resolveTestDatabaseUrl,
} from "../../support/database.js";
import { createPostgresHarness, uniqueId } from "../../support/postgres-harness.js";
import type { PostgresHarness } from "../../support/postgres-harness.js";
import type { Order } from "../../../src/domain/order.js";

const databaseUrl = resolveTestDatabaseUrl();
if (databaseUrl === null) {
  console.warn(DATABASE_SKIP_MESSAGE);
}
const describeWithDatabase = describe.skipIf(databaseUrl === null);

const lastUnitProduct = { id: uniqueId("it-nooversell-1"), name: "Last Unit", priceCents: 999, stock: 1 };
const threeUnitsProduct = { id: uniqueId("it-nooversell-3"), name: "Three Units", priceCents: 1999, stock: 3 };
const testProducts = [lastUnitProduct, threeUnitsProduct];
const customerEmail = "concurrent@example.com";

describeWithDatabase("concurrent order creation never oversells", () => {
  let database: TestDatabase;
  let harness: PostgresHarness;

  beforeAll(async () => {
    database = await TestDatabase.open(databaseUrl as string);
  });

  beforeEach(async () => {
    // Fresh adapters and an empty notification double per test, with the catalog rows reset.
    harness = createPostgresHarness(database.pool);
    await database.removeTestData(testProducts.map((product) => product.id));
    for (const product of testProducts) {
      await database.insertProduct(product);
    }
  });

  afterAll(async () => {
    await database.removeTestData(testProducts.map((product) => product.id));
    await database.close();
  });

  async function settle(productId: string, quantity: number, times: number) {
    return Promise.allSettled(
      Array.from({ length: times }, () =>
        harness.useCases.createOrder.execute({ productId, quantity, customerEmail }),
      ),
    );
  }

  it("accepts exactly one of two parallel orders for the last unit", async () => {
    const results = await settle(lastUnitProduct.id, 1, 2);
    const accepted = results.filter(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<Order>[];
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as Error).message).toBe("Insufficient stock");

    // Final stock is zero, never negative, and exactly one order plus one intent exists.
    expect((await database.readProduct(lastUnitProduct.id))?.stock).toBe(0);
    const orders = await database.readOrdersForProduct(lastUnitProduct.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.id).toBe(accepted[0]?.value.id);
    expect(orders[0]?.total_cents).toBe(lastUnitProduct.priceCents);

    const intents = await database.readOutboxForOrder(accepted[0]?.value.id as string);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe("SENT");
    expect(harness.notifications.recordsFor(accepted[0]?.value.id as string)).toHaveLength(1);
  });

  it("accepts three of five parallel orders for three units", async () => {
    const results = await settle(threeUnitsProduct.id, 1, 5);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const rejection of rejected) {
      expect((rejection.reason as Error).message).toBe("Insufficient stock");
    }

    expect((await database.readProduct(threeUnitsProduct.id))?.stock).toBe(0);
    const orders = await database.readOrdersForProduct(threeUnitsProduct.id);
    expect(orders).toHaveLength(3);
    expect(orders.reduce((total, order) => total + order.quantity, 0)).toBe(3);
    for (const order of orders) {
      expect(await database.readOutboxForOrder(order.id)).toHaveLength(1);
      expect(harness.notifications.recordsFor(order.id)).toHaveLength(1);
    }
    expect(harness.notifications.records).toHaveLength(3);
  });

  it("keeps stock consistent when parallel orders request more than one unit each", async () => {
    const results = await settle(threeUnitsProduct.id, 2, 4);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    expect((await database.readProduct(threeUnitsProduct.id))?.stock).toBe(1);
    expect(await database.readOrdersForProduct(threeUnitsProduct.id)).toHaveLength(1);
    expect(harness.notifications.records).toHaveLength(1);
  });
});
