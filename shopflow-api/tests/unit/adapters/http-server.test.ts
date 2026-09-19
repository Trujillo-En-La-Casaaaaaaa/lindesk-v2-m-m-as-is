import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "../../support/harness.js";
import { postJson, request, startHttpServer } from "../../support/http-server.js";
import type { TestServer } from "../../support/http-server.js";
import { sampleProduct } from "../../support/fakes.js";

/**
 * The real Express adapter over in-memory test doubles: routing, request parsing, status codes,
 * response shapes and the 404 surface are asserted without any infrastructure.
 */
const harness = createHarness({
  products: [
    sampleProduct({ id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 }),
    sampleProduct({ id: "prod-b", name: "Product B", priceCents: 999, stock: 10 }),
  ],
});

let server: TestServer;

beforeAll(async () => {
  server = await startHttpServer(harness.useCases);
});

afterAll(async () => {
  await server.close();
});

describe("HTTP adapter", () => {
  it("answers /api/health without touching the database or the provider", async () => {
    const response = await request(server.baseUrl, "/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(harness.unitOfWork.runs).toBe(0);
    expect(harness.productRepository.calls.list).toBe(0);
    expect(harness.productRepository.calls.getById).toBe(0);
    expect(harness.orderRepository.calls.getById).toBe(0);
    expect(harness.orderRepository.calls.markShipped).toBe(0);
    expect(harness.notifications.submissions).toHaveLength(0);
  });

  it("serves the catalog with the exact product key set", async () => {
    const response = await request(server.baseUrl, "/api/products");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
      { id: "prod-b", name: "Product B", priceCents: 999, stock: 10 },
    ]);
  });

  it("serves a single product and answers Not found for unknown ids", async () => {
    expect(await request(server.baseUrl, "/api/products/prod-a")).toMatchObject({
      status: 200,
      body: { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
    });
    for (const path of [
      "/api/products/unknown",
      "/api/products/weird%20id%3B%20--",
      "/api/products/%20",
      "/api/products/prod-a/x",
    ]) {
      expect(await request(server.baseUrl, path)).toMatchObject({
        status: 404,
        body: { error: "Not found" },
      });
    }

    // Express non-strict routing tolerates the trailing slash, exactly like the legacy process did:
    // `/api/products/` is the catalog route, not a product lookup with an empty id.
    expect(await request(server.baseUrl, "/api/products/")).toMatchObject({ status: 200 });
  });

  it("creates an order, returns it and exposes the notification immediately", async () => {
    const created = await postJson(server.baseUrl, "/api/orders", {
      productId: "prod-a",
      quantity: 2,
      customerEmail: "customer@example.com",
    });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: "id-1",
      customerEmail: "customer@example.com",
      status: "CONFIRMED",
      productId: "prod-a",
      quantity: 2,
      totalCents: 3998,
      createdAt: "2026-09-17T10:15:00.000Z",
      cancelledAt: null,
      cancellationReason: null,
    });

    const order = await request(server.baseUrl, "/api/orders/id-1");
    expect(order.status).toBe(200);
    expect(order.body).toEqual(created.body);

    const notifications = await request(server.baseUrl, "/api/notifications");
    expect(notifications.status).toBe(200);
    expect(notifications.body).toEqual([
      {
        id: "notification-1",
        type: "ORDER_CONFIRMATION",
        orderId: "id-1",
        createdAt: "2026-09-17T10:15:00.000Z",
        payload: { customerEmail: "customer@example.com", orderId: "id-1" },
      },
    ]);
  });

  it("maps invalid order input to 400 Invalid order", async () => {
    for (const body of [
      {},
      { productId: "prod-a", quantity: 1, customerEmail: "" },
      { productId: "prod-a", quantity: 0, customerEmail: "a@b.c" },
      { productId: "prod-a", quantity: -3, customerEmail: "a@b.c" },
    ]) {
      const response = await postJson(server.baseUrl, "/api/orders", body);
      expect(response).toMatchObject({ status: 400, body: { error: "Invalid order" } });
    }
  });

  it("maps an unknown product to 404 Product not found and stock exhaustion to 400 Insufficient stock", async () => {
    expect(
      await postJson(server.baseUrl, "/api/orders", {
        productId: "prod-missing",
        quantity: 1,
        customerEmail: "a@b.c",
      }),
    ).toMatchObject({ status: 404, body: { error: "Product not found" } });

    expect(
      await postJson(server.baseUrl, "/api/orders", {
        productId: "prod-b",
        quantity: 999,
        customerEmail: "a@b.c",
      }),
    ).toMatchObject({ status: 400, body: { error: "Insufficient stock" } });
  });

  it("ships an order once and rejects repeat or unknown ship calls", async () => {
    const shipped = await request(server.baseUrl, "/api/orders/id-1/ship", { method: "POST" });
    expect(shipped.status).toBe(200);
    expect(shipped.body).toMatchObject({ id: "id-1", status: "SHIPPED" });

    expect(await request(server.baseUrl, "/api/orders/id-1/ship", { method: "POST" })).toMatchObject({
      status: 400,
      body: { error: "Cannot ship order" },
    });
    expect(
      await request(server.baseUrl, "/api/orders/unknown/ship", { method: "POST" }),
    ).toMatchObject({ status: 400, body: { error: "Cannot ship order" } });
  });

  it("answers 404 for orders that do not exist", async () => {
    expect(await request(server.baseUrl, "/api/orders/unknown")).toMatchObject({
      status: 404,
      body: { error: "Not found" },
    });
  });

  it("exposes no cancellation or order-editing surface", async () => {
    for (const [method, path] of [
      ["POST", "/api/orders/id-1/cancel"],
      ["POST", "/api/orders/id-1/cancellation"],
      ["PATCH", "/api/orders/id-1"],
      ["PUT", "/api/orders/id-1"],
      ["DELETE", "/api/orders/id-1"],
      ["GET", "/api/orders"],
      ["POST", "/api/products/id-1/stock"],
      ["GET", "/"],
      ["GET", "/orders/new"],
      ["GET", "/api"],
    ] as const) {
      const response = await request(server.baseUrl, path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.body, `${method} ${path}`).toEqual({ error: "Not found" });
    }
  });

  it("keeps the JSON error envelope for malformed request bodies", async () => {
    const response = await request(server.baseUrl, "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
    expect(typeof (response.body as { error: unknown }).error).toBe("string");
  });

  it("accepts form-encoded bodies exactly like the legacy urlencoded middleware", async () => {
    const response = await request(server.baseUrl, "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        productId: "prod-b",
        quantity: "1",
        customerEmail: "form@example.com",
      }).toString(),
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      productId: "prod-b",
      quantity: 1,
      totalCents: 999,
      customerEmail: "form@example.com",
      status: "CONFIRMED",
    });
  });
});
