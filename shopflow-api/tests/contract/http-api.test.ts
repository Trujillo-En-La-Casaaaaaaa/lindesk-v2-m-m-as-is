import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComposition } from "../../src/main.js";
import { TestDatabase, resolveTestDatabaseUrl } from "../support/database.js";
import { postJson, request, resolveApiBaseUrl, resolveProviderUrl } from "../support/http-server.js";
import type { HttpResponse } from "../support/http-server.js";

/**
 * The frozen `/api/*` contract, asserted end to end.
 *
 * Two supported modes, both exercised through real HTTP:
 * - live stack: `BASE_URL=http://127.0.0.1:3001` (or `API_BASE_URL`, plus `PROVIDER_URL`) against the
 *   composed system, using the catalog seeded by shopflow-infra;
 * - in-process: `TEST_DATABASE_URL` (plus `PROVIDER_URL`) starts the composed service on an ephemeral
 *   port with the real PostgreSQL adapters and the real HTTP notification adapter.
 *
 * When neither is available the suite skips with an explicit message.
 */
const liveBaseUrl = resolveApiBaseUrl();
const providerUrl = resolveProviderUrl();
const databaseUrl = resolveTestDatabaseUrl();

const missingPreconditions = [
  liveBaseUrl === null && databaseUrl === null
    ? "BASE_URL/API_BASE_URL (composed stack) or TEST_DATABASE_URL (in-process server)"
    : null,
  providerUrl === null ? "PROVIDER_URL (notification provider)" : null,
].filter((entry): entry is string => entry !== null);

if (missingPreconditions.length > 0) {
  console.warn(
    `[skip] frozen HTTP contract suite skipped: provide ${missingPreconditions.join(" and ")}`,
  );
}

const describeContract = describe.skipIf(missingPreconditions.length > 0);

const ORDER_KEYS = [
  "cancellationReason",
  "cancelledAt",
  "createdAt",
  "customerEmail",
  "id",
  "productId",
  "quantity",
  "status",
  "totalCents",
];
const NOTIFICATION_KEYS = ["createdAt", "id", "orderId", "payload", "type"];
const PRODUCT_KEYS = ["id", "name", "priceCents", "stock"];
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ProductPayload {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

interface OrderPayload {
  id: string;
  customerEmail: string;
  status: string;
  productId: string;
  quantity: number;
  totalCents: number;
  createdAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

interface NotificationRecordPayload {
  id: string;
  type: string;
  orderId: string;
  createdAt: string;
  payload: { customerEmail?: string; orderId?: string };
}

describeContract("frozen HTTP contract", () => {
  const provisionedProductId = `api-contract-${randomUUID()}`;
  let baseUrl = "";
  let productId = "";
  let database: TestDatabase | null = null;
  let composition: ReturnType<typeof createComposition> | null = null;
  let server: Server | null = null;

  beforeAll(async () => {
    if (liveBaseUrl !== null) {
      baseUrl = liveBaseUrl;
      const response = await request(baseUrl, "/api/products");
      const products = (response.body ?? []) as ProductPayload[];
      const seed = products.find((product) => product.id === "prod-a") ?? products[0];
      if (seed === undefined) {
        throw new Error("the live catalog is empty; start the composed stack with the infra seed");
      }
      productId = seed.id;
      return;
    }

    database = await TestDatabase.open(databaseUrl as string);
    await database.insertProduct({
      id: provisionedProductId,
      name: "Contract Product",
      priceCents: 1999,
      stock: 20,
    });
    productId = provisionedProductId;

    const started = createComposition({
      databaseUrl: databaseUrl as string,
      notificationProviderUrl: providerUrl as string,
      port: 0,
      notificationRetryAttempts: 3,
      outboxRelayIntervalMs: 60_000,
    });
    composition = started;
    server = await new Promise<Server>((resolve) => {
      const listener = started.app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (composition !== null) {
      await composition.close();
    }
    if (database !== null) {
      await database.removeTestData([provisionedProductId]);
      await database.close();
    }
  });

  async function readProductPayload(id: string): Promise<ProductPayload> {
    const response = await request(baseUrl, `/api/products/${id}`);
    expect(response.status).toBe(200);
    return response.body as ProductPayload;
  }

  async function listNotifications(): Promise<NotificationRecordPayload[]> {
    const response = await request(baseUrl, "/api/notifications");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    return response.body as NotificationRecordPayload[];
  }

  function notificationsFor(
    notifications: NotificationRecordPayload[],
    orderId: string,
  ): NotificationRecordPayload[] {
    return notifications.filter((record) => record.orderId === orderId);
  }

  async function createOrder(
    quantity: number,
    customerEmail: string,
  ): Promise<HttpResponse & { body: OrderPayload }> {
    const response = await postJson(baseUrl, "/api/orders", {
      productId,
      quantity,
      customerEmail,
    });
    return response as HttpResponse & { body: OrderPayload };
  }

  /** The live seed catalog can be exhausted by earlier runs: skip with an explicit message instead. */
  async function requireStock(quantity: number, skip: () => never): Promise<ProductPayload> {
    const product = await readProductPayload(productId);
    if (product.stock < quantity) {
      skip();
    }
    return product;
  }

  it('GET /api/health answers 200 {"ok":true}', async () => {
    const response = await request(baseUrl, "/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("GET /api/products returns the catalog ordered by id with the exact key set", async () => {
    const response = await request(baseUrl, "/api/products");

    expect(response.status).toBe(200);
    const products = response.body as ProductPayload[];
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBeGreaterThan(0);

    const ids = products.map((product) => product.id);
    expect([...ids].sort()).toEqual(ids);
    for (const product of products) {
      expect(Object.keys(product).sort()).toEqual(PRODUCT_KEYS);
    }

    const expected = products.find((product) => product.id === productId);
    expect(expected).toBeDefined();
    if (database !== null) {
      expect(expected).toMatchObject({
        id: provisionedProductId,
        name: "Contract Product",
        priceCents: 1999,
        stock: 20,
      });
    }
  });

  it("GET /api/products/:id returns the product and 404 Not found for unknown ids", async () => {
    const product = await readProductPayload(productId);
    expect(Object.keys(product).sort()).toEqual(PRODUCT_KEYS);

    for (const path of [
      `/api/products/${randomUUID()}`,
      "/api/products/unknown-product",
      "/api/products/weird%20id%3B%20--",
    ]) {
      expect(await request(baseUrl, path)).toMatchObject({
        status: 404,
        body: { error: "Not found" },
      });
    }
  });

  it("POST /api/orders creates a CONFIRMED order and decrements stock by the quantity", async (ctx) => {
    const before = await requireStock(2, () => ctx.skip());

    const created = await createOrder(2, "contract@example.com");

    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(ORDER_KEYS);
    expect(created.body).toMatchObject({
      customerEmail: "contract@example.com",
      status: "CONFIRMED",
      productId,
      quantity: 2,
      totalCents: before.priceCents * 2,
      cancelledAt: null,
      cancellationReason: null,
    });
    expect(created.body.id).toMatch(UUID_V4);
    expect(created.body.createdAt).toMatch(ISO_MILLIS);
    expect(new Date(created.body.createdAt).toISOString()).toBe(created.body.createdAt);

    // Stock decreased by exactly the ordered quantity.
    expect((await readProductPayload(productId)).stock).toBe(before.stock - 2);

    // GET /api/orders/:id returns the same order.
    const readBack = await request(baseUrl, `/api/orders/${created.body.id}`);
    expect(readBack.status).toBe(200);
    expect(readBack.body).toEqual(created.body);

    expect(await request(baseUrl, `/api/orders/${randomUUID()}`)).toMatchObject({
      status: 404,
      body: { error: "Not found" },
    });
    expect(await request(baseUrl, "/api/orders/weird%20id%3B%20--")).toMatchObject({
      status: 404,
      body: { error: "Not found" },
    });
  });

  it("produces the order-confirmation notification before the 201 is answered", async (ctx) => {
    await requireStock(1, () => ctx.skip());
    const created = await createOrder(1, "notify@example.com");
    expect(created.status).toBe(201);

    const notifications = await listNotifications();
    const records = notificationsFor(notifications, created.body.id);

    expect(records).toHaveLength(1);
    expect(Object.keys(records[0] as object).sort()).toEqual(NOTIFICATION_KEYS);
    expect(records[0]).toMatchObject({
      type: "ORDER_CONFIRMATION",
      orderId: created.body.id,
      payload: { customerEmail: "notify@example.com", orderId: created.body.id },
    });
    expect(records[0]?.createdAt).toMatch(ISO_MILLIS);
  });

  it("keeps the notification list in insertion order", async (ctx) => {
    await requireStock(2, () => ctx.skip());
    const first = await createOrder(1, "order-first@example.com");
    const second = await createOrder(1, "order-second@example.com");
    expect([first.status, second.status]).toEqual([201, 201]);

    const notifications = await listNotifications();
    const firstIndex = notifications.findIndex((record) => record.orderId === first.body.id);
    const secondIndex = notifications.findIndex((record) => record.orderId === second.body.id);

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("rejects invalid order input with the frozen messages and status codes", async () => {
    expect(
      await postJson(baseUrl, "/api/orders", {
        productId,
        quantity: 1,
        customerEmail: "",
      }),
    ).toMatchObject({ status: 400, body: { error: "Invalid order" } });

    expect(await postJson(baseUrl, "/api/orders", { productId, quantity: 1 })).toMatchObject({
      status: 400,
      body: { error: "Invalid order" },
    });

    for (const quantity of [0, -1, -99]) {
      expect(
        await postJson(baseUrl, "/api/orders", {
          productId,
          quantity,
          customerEmail: "contract@example.com",
        }),
      ).toMatchObject({ status: 400, body: { error: "Invalid order" } });
    }

    expect(await postJson(baseUrl, "/api/orders", {})).toMatchObject({
      status: 400,
      body: { error: "Invalid order" },
    });

    expect(
      await postJson(baseUrl, "/api/orders", {
        productId: randomUUID(),
        quantity: 1,
        customerEmail: "contract@example.com",
      }),
    ).toMatchObject({ status: 404, body: { error: "Product not found" } });
  });

  it("rejects an order above the available stock without changing the stock", async () => {
    const product = await readProductPayload(productId);

    expect(
      await postJson(baseUrl, "/api/orders", {
        productId,
        quantity: product.stock + 1,
        customerEmail: "contract@example.com",
      }),
    ).toMatchObject({ status: 400, body: { error: "Insufficient stock" } });

    expect((await readProductPayload(productId)).stock).toBe(product.stock);
  });

  it("ships a CONFIRMED order once, without touching stock and without notifying again", async (ctx) => {
    const before = await requireStock(1, () => ctx.skip());
    const created = await createOrder(1, "ship@example.com");
    expect(created.status).toBe(201);

    const shipped = await request(baseUrl, `/api/orders/${created.body.id}/ship`, { method: "POST" });
    expect(shipped.status).toBe(200);
    expect(Object.keys(shipped.body as object).sort()).toEqual(ORDER_KEYS);
    expect(shipped.body).toMatchObject({ id: created.body.id, status: "SHIPPED" });

    // The transition is guarded; the order stays SHIPPED and stock is untouched by shipping.
    expect(
      await request(baseUrl, `/api/orders/${created.body.id}/ship`, { method: "POST" }),
    ).toMatchObject({ status: 400, body: { error: "Cannot ship order" } });
    expect(
      await request(baseUrl, `/api/orders/${randomUUID()}/ship`, { method: "POST" }),
    ).toMatchObject({ status: 400, body: { error: "Cannot ship order" } });

    expect((await readProductPayload(productId)).stock).toBe(before.stock - 1);
    const readBack = await request(baseUrl, `/api/orders/${created.body.id}`);
    expect(readBack.body).toMatchObject({ status: "SHIPPED" });
    const notifications = await listNotifications();
    expect(notificationsFor(notifications, created.body.id)).toHaveLength(1);
  });

  it("exposes no cancellation or order-editing surface", async () => {
    const orderId = randomUUID();
    for (const [method, path] of [
      ["POST", `/api/orders/${orderId}/cancel`],
      ["POST", "/api/orders/cancel"],
      ["PATCH", `/api/orders/${orderId}`],
      ["PUT", `/api/orders/${orderId}`],
      ["DELETE", `/api/orders/${orderId}`],
      ["GET", "/api/orders"],
      ["POST", "/api/products"],
      ["GET", "/"],
      ["GET", "/orders/new"],
      ["GET", "/api/unknown"],
    ] as const) {
      const response = await request(baseUrl, path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
