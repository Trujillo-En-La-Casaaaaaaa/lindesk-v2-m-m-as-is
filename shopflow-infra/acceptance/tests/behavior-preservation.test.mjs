import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Black-box acceptance: the eight preserved behaviours plus the notification side effect and the
 * absence of any cancellation surface, driven over HTTP against the composed stack through the single
 * published origin (`BASE_URL`, default `http://web` inside the Compose network).
 *
 * Requirement 1 asserts the catalog exactly as the migration seeded it, so this suite must run on a
 * freshly reset stack (`docker compose down -v` + `docker compose up -d --build`); `run-acceptance.sh`
 * / `run-acceptance.ps1` does that.
 */

const BASE_URL = (process.env.BASE_URL ?? "http://web").replace(/\/+$/, "");
const RESET_HINT =
  "the stack must be freshly seeded; reset it with: docker compose down -v && docker compose up -d --build";

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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

async function send(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: response.status,
    body,
    text,
    contentType: response.headers.get("content-type") ?? "",
  };
}

function postJson(path, body) {
  return send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path) {
  return send(path, { method: "POST" });
}

async function productStock(id) {
  const response = await send(`/api/products/${id}`);
  assert.equal(response.status, 200, `GET /api/products/${id} must answer 200`);
  return response.body.stock;
}

async function notifications() {
  const response = await send("/api/notifications");
  assert.equal(response.status, 200, "GET /api/notifications must answer 200");
  assert.ok(Array.isArray(response.body), "GET /api/notifications must answer a JSON array");
  return response.body;
}

const state = {
  order: null,
  orderedQuantity: 2,
  stockBeforeOrder: null,
};

describe("preserved behaviour of the migrated ShopFlow stack", () => {
  it("acceptance criterion 1: the composed stack answers on the published origin", async () => {
    const health = await send("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });
  });

  it("requirement 1: GET /api/products returns the seeded catalog ordered by id and GET / serves the SPA", async () => {
    const products = await send("/api/products");
    assert.equal(products.status, 200);
    assert.deepEqual(
      products.body,
      [
        { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
        { id: "prod-b", name: "Product B", priceCents: 999, stock: 10 },
      ],
      RESET_HINT,
    );

    const home = await send("/");
    assert.equal(home.status, 200, "GET / must serve the SPA document");
    assert.match(home.contentType, /text\/html/);
    assert.match(home.text, /<html[\s>]/i);
    assert.match(home.text, /<\/html>/i);
  });

  it("requirement 2: GET /api/products/:id returns the product with its current stock", async () => {
    const product = await send("/api/products/prod-a");
    assert.equal(product.status, 200);
    assert.deepEqual(
      product.body,
      { id: "prod-a", name: "Product A", priceCents: 1999, stock: 20 },
      RESET_HINT,
    );

    const unknown = await send("/api/products/does-not-exist");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: "Not found" });
  });

  it("requirement 3: POST /api/orders creates a CONFIRMED order with the preserved payload shape", async () => {
    const before = await notifications();
    state.stockBeforeOrder = await productStock("prod-a");

    const created = await postJson("/api/orders", {
      productId: "prod-a",
      quantity: state.orderedQuantity,
      customerEmail: "acceptance@example.com",
    });

    assert.equal(created.status, 201);
    const order = created.body;
    assert.deepEqual(Object.keys(order).sort(), ORDER_KEYS);
    assert.equal(typeof order.id, "string");
    assert.ok(order.id.length > 0, "the order must carry an id");
    assert.equal(order.customerEmail, "acceptance@example.com");
    assert.equal(order.status, "CONFIRMED");
    assert.equal(order.productId, "prod-a");
    assert.equal(order.quantity, state.orderedQuantity);
    assert.equal(order.totalCents, 1999 * state.orderedQuantity);
    assert.match(order.createdAt, ISO_MILLIS);
    assert.equal(order.cancelledAt, null);
    assert.equal(order.cancellationReason, null);

    state.order = order;

    // The confirmation is delivered in-request: it is already readable right after the 201.
    assert.equal((await notifications()).length, before.length + 1);
  });

  it("requirement 4: rejected orders keep their exact contract and change nothing", async () => {
    const before = await notifications();
    const stockBefore = await productStock("prod-a");

    const missingEmail = await postJson("/api/orders", { productId: "prod-a", quantity: 1 });
    assert.deepEqual([missingEmail.status, missingEmail.body], [400, { error: "Invalid order" }]);

    const zeroQuantity = await postJson("/api/orders", {
      productId: "prod-a",
      quantity: 0,
      customerEmail: "rejected@example.com",
    });
    assert.deepEqual([zeroQuantity.status, zeroQuantity.body], [400, { error: "Invalid order" }]);

    const negativeQuantity = await postJson("/api/orders", {
      productId: "prod-a",
      quantity: -1,
      customerEmail: "rejected@example.com",
    });
    assert.deepEqual([negativeQuantity.status, negativeQuantity.body], [
      400,
      { error: "Invalid order" },
    ]);

    const unknownProduct = await postJson("/api/orders", {
      productId: "does-not-exist",
      quantity: 1,
      customerEmail: "rejected@example.com",
    });
    assert.deepEqual([unknownProduct.status, unknownProduct.body], [
      404,
      { error: "Product not found" },
    ]);

    const aboveStock = await postJson("/api/orders", {
      productId: "prod-a",
      quantity: stockBefore + 1,
      customerEmail: "rejected@example.com",
    });
    assert.deepEqual([aboveStock.status, aboveStock.body], [400, { error: "Insufficient stock" }]);

    assert.equal(
      await productStock("prod-a"),
      stockBefore,
      "a rejected order must not change the stock",
    );
    assert.equal(
      (await notifications()).length,
      before.length,
      "a rejected order must not create an order row or a notification",
    );
  });

  it("requirement 4: a non-numeric quantity keeps its legacy 500 path and creates no order", async () => {
    const before = await notifications();
    const stockBefore = await productStock("prod-a");

    const nonNumeric = await postJson("/api/orders", {
      productId: "prod-a",
      quantity: "many",
      customerEmail: "rejected@example.com",
    });

    assert.equal(
      nonNumeric.status,
      500,
      "a non-numeric quantity stays the legacy 500 path, never a new 400 branch",
    );
    assert.equal(await productStock("prod-a"), stockBefore);
    assert.equal((await notifications()).length, before.length);
  });

  it("requirement 5: a successful order decremented the stock by the ordered quantity", async () => {
    const stockAfter = await productStock("prod-a");
    assert.equal(stockAfter, state.stockBeforeOrder - state.orderedQuantity);
  });

  it("requirement 6: GET /api/orders/:id returns the created order and 404 Not found for an unknown id", async () => {
    const found = await send(`/api/orders/${state.order.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, state.order);

    const unknown = await send("/api/orders/does-not-exist");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: "Not found" });
  });

  it("requirement 7: POST /api/orders/:id/ship is a guarded one-way transition that never touches stock", async () => {
    const stockBefore = await productStock("prod-a");

    const shipped = await post(`/api/orders/${state.order.id}/ship`);
    assert.equal(shipped.status, 200);
    assert.equal(shipped.body.status, "SHIPPED");
    assert.equal(shipped.body.id, state.order.id);
    assert.deepEqual(Object.keys(shipped.body).sort(), ORDER_KEYS);
    assert.equal(shipped.body.cancelledAt, null);
    assert.equal(shipped.body.cancellationReason, null);

    const secondShip = await post(`/api/orders/${state.order.id}/ship`);
    assert.deepEqual([secondShip.status, secondShip.body], [400, { error: "Cannot ship order" }]);

    const unknownShip = await post("/api/orders/does-not-exist/ship");
    assert.deepEqual([unknownShip.status, unknownShip.body], [400, { error: "Cannot ship order" }]);

    assert.equal(
      await productStock("prod-a"),
      stockBefore,
      "shipping must not change the stock of any product",
    );

    const reread = await send(`/api/orders/${state.order.id}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.body.status, "SHIPPED");
  });

  it("requirement 8: exactly one ORDER_CONFIRMATION exists for the order and none for rejected orders", async () => {
    const records = await notifications();
    assert.equal(
      records.length,
      1,
      "only the single successful order may have produced a notification",
    );

    const [record] = records;
    assert.deepEqual(Object.keys(record).sort(), NOTIFICATION_KEYS);
    assert.equal(record.type, "ORDER_CONFIRMATION");
    assert.equal(record.orderId, state.order.id);
    assert.equal(typeof record.id, "string");
    assert.match(record.createdAt, ISO_MILLIS);
    assert.deepEqual(record.payload, {
      customerEmail: "acceptance@example.com",
      orderId: state.order.id,
    });
  });

  it("requirement 9: no cancellation surface exists", async () => {
    const withBody = await postJson(`/api/orders/${state.order.id}/cancel`, {});
    assert.equal(withBody.status, 404, "POST /api/orders/:id/cancel must not exist");

    const withoutBody = await post(`/api/orders/${state.order.id}/cancel`);
    assert.equal(withoutBody.status, 404);

    const order = await send(`/api/orders/${state.order.id}`);
    assert.equal(order.status, 200);
    assert.equal(order.body.status, "SHIPPED");
    assert.equal(order.body.cancelledAt, null);
    assert.equal(order.body.cancellationReason, null);
  });
});
