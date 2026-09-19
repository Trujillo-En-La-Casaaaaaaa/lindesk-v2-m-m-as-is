import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "../support/harness.js";
import { postJson, request, startHttpServer } from "../support/http-server.js";
import type { TestServer } from "../support/http-server.js";
import { sampleProduct } from "../support/fakes.js";

/**
 * Characterization of the preserved (and slightly awkward) legacy HTTP edge cases that need no
 * infrastructure. The database-backed half of the same characterization lives in
 * `tests/characterization/legacy-database-edge-cases.test.ts`.
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

describe("legacy input coercion and identifier handling", () => {
  it("treats path identifiers as opaque strings and never raises a driver error", async () => {
    const weirdIds = [
      "weird id; --",
      "00000000-0000-0000-0000-000000000000",
      "'; DROP TABLE orders; --",
      "%00",
      "ünïcøde",
      "very-long-".concat("x".repeat(300)),
    ];

    for (const id of weirdIds) {
      const product = await request(server.baseUrl, `/api/products/${encodeURIComponent(id)}`);
      expect(product.status, `product ${id}`).toBe(404);
      expect(product.body).toEqual({ error: "Not found" });

      const order = await request(server.baseUrl, `/api/orders/${encodeURIComponent(id)}`);
      expect(order.status, `order ${id}`).toBe(404);
      expect(order.body).toEqual({ error: "Not found" });

      const ship = await request(server.baseUrl, `/api/orders/${encodeURIComponent(id)}/ship`, {
        method: "POST",
      });
      expect(ship.status, `ship ${id}`).toBe(400);
      expect(ship.body).toEqual({ error: "Cannot ship order" });
    }
  });

  it("keeps the legacy coercion defaults for missing and null fields", async () => {
    for (const body of [
      undefined,
      {},
      { productId: null, quantity: null, customerEmail: null },
      { quantity: 1 },
    ]) {
      const response = await postJson(server.baseUrl, "/api/orders", body);
      expect(response).toMatchObject({ status: 400, body: { error: "Invalid order" } });
    }
  });

  it("does not invent a 400 validation branch for a non-numeric quantity: the input reaches the data layer", async () => {
    const runsBefore = harness.unitOfWork.runs;

    const response = await postJson(server.baseUrl, "/api/orders", {
      productId: "prod-a",
      quantity: "abc",
      customerEmail: "legacy@example.com",
    });

    // Never a success and never the validation message: `Number("abc")` is NaN and `NaN < 1` is false
    // in the preserved rule, so the use case entered its transaction instead of rejecting the input.
    // The exact database outcome of that path (500, no order row, unchanged stock) is asserted against
    // real PostgreSQL in tests/characterization/legacy-database-edge-cases.test.ts.
    expect(response.status).not.toBe(201);
    expect(response.body).not.toEqual({ error: "Invalid order" });
    expect(harness.unitOfWork.runs).toBe(runsBefore + 1);
  });

  it("does not parse a JSON body sent as text/plain (preserved middleware behaviour)", async () => {
    const response = await request(server.baseUrl, "/api/orders", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ productId: "prod-a", quantity: 1, customerEmail: "text@example.com" }),
    });

    expect(response).toMatchObject({ status: 400, body: { error: "Invalid order" } });
  });

  it("coerces numbers and booleans with String()/Number() exactly like the legacy controller", async () => {
    const response = await postJson(server.baseUrl, "/api/orders", {
      productId: 123,
      quantity: "1",
      customerEmail: 456,
    });

    // productId "123" does not exist and customerEmail "456" is non-empty, so the product lookup is
    // what fails first: the coerced email passed validation and the missing product produced the 404.
    expect(response).toMatchObject({ status: 404, body: { error: "Product not found" } });
    expect(harness.store.orders).toHaveLength(0);
  });
});
