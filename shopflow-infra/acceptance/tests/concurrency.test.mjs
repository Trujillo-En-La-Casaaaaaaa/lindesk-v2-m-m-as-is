import assert from "node:assert/strict";
import { it } from "node:test";

/**
 * Black-box acceptance: the inventory concurrency invariant.
 *
 * `prod-b` is driven down to its last unit with sequential orders, then two order requests are fired
 * in parallel for that last unit. Exactly one may succeed, the other must be rejected with the
 * preserved `400 Insufficient stock`, the stock must land on exactly `0` and exactly one
 * ORDER_CONFIRMATION must exist for the successful order.
 *
 * Run against a freshly reset stack (a stack with `prod-b` already sold out cannot exercise the race).
 */

const BASE_URL = (process.env.BASE_URL ?? "http://web").replace(/\/+$/, "");
const PRODUCT_ID = "prod-b";
const MAX_SEQUENTIAL_ORDERS = 50;

async function send(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

function postJson(path, body) {
  return send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function productStock(id) {
  const response = await send(`/api/products/${id}`);
  assert.equal(response.status, 200, `GET /api/products/${id} must answer 200`);
  return response.body.stock;
}

async function notifications() {
  const response = await send("/api/notifications");
  assert.equal(response.status, 200, "GET /api/notifications must answer 200");
  assert.ok(Array.isArray(response.body));
  return response.body;
}

function order(productId, customerEmail) {
  return { productId, quantity: 1, customerEmail };
}

it(
  "concurrency invariant: two parallel orders for the last unit of prod-b produce exactly one 201",
  { timeout: 180_000 },
  async () => {
    const notificationsBefore = await notifications();

    let stock = await productStock(PRODUCT_ID);
    assert.ok(
      stock > 0,
      `${PRODUCT_ID} is already sold out; reset the stack with: docker compose down -v && docker compose up -d --build`,
    );

    // 1. Drive the stock down to its last unit with sequential orders.
    let sequentialOrders = 0;
    while (stock > 1) {
      assert.ok(
        sequentialOrders < MAX_SEQUENTIAL_ORDERS,
        `could not drive ${PRODUCT_ID} down to its last unit`,
      );
      const created = await postJson(
        "/api/orders",
        order(PRODUCT_ID, "concurrency-sequential@example.com"),
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.productId, PRODUCT_ID);
      stock = await productStock(PRODUCT_ID);
      sequentialOrders += 1;
    }
    assert.equal(stock, 1, `${PRODUCT_ID} must hold exactly its last unit before the race`);

    // 2. Fire both requests for that last unit in parallel.
    const responses = await Promise.all([
      postJson("/api/orders", order(PRODUCT_ID, "concurrency-race@example.com")),
      postJson("/api/orders", order(PRODUCT_ID, "concurrency-race@example.com")),
    ]);

    const winners = responses.filter((response) => response.status === 201);
    const losers = responses.filter((response) => response.status !== 201);
    assert.equal(
      winners.length,
      1,
      `exactly one request may win the last unit, got ${JSON.stringify(
        responses.map((response) => [response.status, response.body]),
      )}`,
    );
    assert.equal(losers.length, 1);
    assert.deepEqual([losers[0].status, losers[0].body], [400, { error: "Insufficient stock" }]);

    // 3. No oversell: the last unit is gone exactly once.
    assert.equal(await productStock(PRODUCT_ID), 0, "the last unit must be sold exactly once");

    // 4. Exactly one notification for the successful order, and one per successful order overall.
    const notificationsAfter = await notifications();
    const winner = winners[0].body;
    assert.equal(
      notificationsAfter.filter((record) => record.orderId === winner.id).length,
      1,
      "the winning order must produce exactly one ORDER_CONFIRMATION",
    );

    const appended = notificationsAfter.filter(
      (record) => !notificationsBefore.some((existing) => existing.id === record.id),
    );
    assert.equal(
      appended.length,
      sequentialOrders + 1,
      "every successful order (sequential plus the race winner) produced exactly one notification",
    );
    assert.equal(
      new Set(appended.map((record) => record.orderId)).size,
      appended.length,
      "no order may be notified twice",
    );
  },
);
