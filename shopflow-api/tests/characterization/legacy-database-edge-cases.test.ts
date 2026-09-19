import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_SKIP_MESSAGE,
  TestDatabase,
  resolveTestDatabaseUrl,
} from "../support/database.js";
import { createPostgresHarness, uniqueId } from "../support/postgres-harness.js";
import type { PostgresHarness } from "../support/postgres-harness.js";
import { postJson, request, startHttpServer } from "../support/http-server.js";
import type { TestServer } from "../support/http-server.js";

/**
 * The database-backed half of the legacy characterization: how the frozen HTTP surface reacts to the
 * inputs whose outcome is decided by PostgreSQL (the non-numeric quantity path) and to the stock
 * boundary. Requests go through the real Express adapter and the real `pg` adapters.
 */
const databaseUrl = resolveTestDatabaseUrl();
if (databaseUrl === null) {
  console.warn(DATABASE_SKIP_MESSAGE);
}
const describeWithDatabase = describe.skipIf(databaseUrl === null);

const product = { id: uniqueId("char-edge"), name: "Characterization Product", priceCents: 1999, stock: 3 };
const customerEmail = "characterization@example.com";

describeWithDatabase("legacy database-backed edge cases", () => {
  let database: TestDatabase;
  let harness: PostgresHarness;
  let server: TestServer;

  beforeAll(async () => {
    database = await TestDatabase.open(databaseUrl as string);
    await database.insertProduct(product);
    harness = createPostgresHarness(database.pool);
    server = await startHttpServer(harness.useCases);
  });

  beforeEach(async () => {
    // Reset the catalog row and the notification double; the adapters stay pooled and connected.
    await database.removeTestData([product.id]);
    await database.insertProduct(product);
    harness.notifications.records.length = 0;
    harness.notifications.submissions.length = 0;
    harness.notifications.failuresRemaining = 0;
  });

  afterAll(async () => {
    await server.close();
    await database.removeTestData([product.id]);
    await database.close();
  });

  it("answers a non-numeric quantity with a non-2xx error, writes nothing and never invents a 400", async () => {
    for (const quantity of ["abc", "not-a-number", "12,5"]) {
      const response = await postJson(server.baseUrl, "/api/orders", {
        productId: product.id,
        quantity,
        customerEmail,
      });

      expect(response.status, `quantity ${quantity}`).toBeGreaterThanOrEqual(400);
      expect(response.status, `quantity ${quantity}`).not.toBe(400);
      expect(response.status, `quantity ${quantity}`).not.toBe(201);
      expect(response.body).toHaveProperty("error");
      expect((response.body as { error: string }).error).toMatch(/invalid input syntax|NaN/i);
    }

    // No order row, no stock change, no delivery intent, no notification.
    expect(await database.readOrdersForProduct(product.id)).toHaveLength(0);
    expect((await database.readProduct(product.id))?.stock).toBe(3);
    expect(
      await database.countOrders(
        "SELECT COUNT(*)::text AS count FROM notification_outbox o JOIN orders r ON r.id = o.order_id WHERE r.product_id = $1",
        [product.id],
      ),
    ).toBe(0);
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("accepts a numeric string quantity and consumes exactly the requested units", async () => {
    const response = await postJson(server.baseUrl, "/api/orders", {
      productId: product.id,
      quantity: "2",
      customerEmail,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ quantity: 2, totalCents: 3998, status: "CONFIRMED" });
    expect((await database.readProduct(product.id))?.stock).toBe(1);
    expect(harness.notifications.records).toHaveLength(1);
  });

  it("succeeds when the quantity equals the committed stock and leaves stock at zero", async () => {
    const response = await postJson(server.baseUrl, "/api/orders", {
      productId: product.id,
      quantity: 3,
      customerEmail,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ quantity: 3, totalCents: 5997 });
    expect((await database.readProduct(product.id))?.stock).toBe(0);

    const orders = await database.readOrdersForProduct(product.id);
    expect(orders).toHaveLength(1);
    expect(await database.readOutboxForOrder(orders[0]?.id as string)).toHaveLength(1);
  });

  it("rejects a quantity above the stock and leaves both tables untouched", async () => {
    const response = await postJson(server.baseUrl, "/api/orders", {
      productId: product.id,
      quantity: 4,
      customerEmail,
    });

    expect(response).toMatchObject({ status: 400, body: { error: "Insufficient stock" } });
    expect((await database.readProduct(product.id))?.stock).toBe(3);
    expect(await database.readOrdersForProduct(product.id)).toHaveLength(0);
    expect(harness.notifications.records).toHaveLength(0);
  });

  it("behaves as documented for empty and unknown identifiers over HTTP", async () => {
    for (const path of [
      `/api/products/${uniqueId("char-missing")}`,
      "/api/products/weird%20id%3B%20--",
      `/api/orders/${uniqueId("char-missing")}`,
      "/api/orders/weird%20id%3B%20--",
    ]) {
      expect(await request(server.baseUrl, path)).toMatchObject({
        status: 404,
        body: { error: "Not found" },
      });
    }

    // `/api/orders/` matches the collection route only for POST payloads; a GET falls through to 404.
    expect(await request(server.baseUrl, "/api/orders/")).toMatchObject({ status: 404 });

    expect(
      await request(server.baseUrl, `/api/orders/${uniqueId("char-missing")}/ship`, { method: "POST" }),
    ).toMatchObject({ status: 400, body: { error: "Cannot ship order" } });

    // No writes happened for any of the reads above.
    expect(await database.readOrdersForProduct(product.id)).toHaveLength(0);
    expect((await database.readProduct(product.id))?.stock).toBe(3);
  });
});
