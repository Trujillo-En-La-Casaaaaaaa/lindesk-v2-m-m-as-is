import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Black-box acceptance: notification durability across a restart and across a provider outage.
 *
 * The file is driven by `run-acceptance.sh` / `run-acceptance.ps1`, which selects the phase with
 * `DURABILITY_PHASE` and restarts the containers between the phases (a black-box test container has no
 * Docker access, so the restart itself is done by the script):
 *
 *   prepare   -> (script: `docker compose restart api`)            -> verify
 *   pending   -> (script: `docker compose start notification-provider`) -> recovered
 *
 * `prepare` creates the order whose survival `verify` asserts; `pending` creates an order while the
 * notification provider is stopped (the legacy post-commit failure path: `500` while the order stays
 * committed and the delivery intent stays `PENDING`); `recovered` asserts the relay delivered it
 * exactly once after the provider came back.
 *
 * Orders are correlated by a marker `customerEmail` built from `DURABILITY_ORDER_TAG`, because the
 * order id of the outage order is deliberately never returned to the client.
 */

const BASE_URL = (process.env.BASE_URL ?? "http://web").replace(/\/+$/, "");
const PHASE = (process.env.DURABILITY_PHASE ?? "verify").trim().toLowerCase();
const ORDER_TAG = (process.env.DURABILITY_ORDER_TAG ?? "default").trim();
const RELAY_INTERVAL_MS = resolveRelayIntervalMs();
const RELAY_MARGIN_MS = 5_000;
const KNOWN_PHASES = ["prepare", "verify", "pending", "recovered"];

const API_RESTART_EMAIL = `durability-api-restart-${ORDER_TAG}@example.com`;
const PROVIDER_OUTAGE_EMAIL = `durability-provider-outage-${ORDER_TAG}@example.com`;
const POST_RESTART_EMAIL = `durability-post-restart-${ORDER_TAG}@example.com`;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function resolveRelayIntervalMs() {
  const value = Number(process.env.OUTBOX_RELAY_INTERVAL_MS ?? "10000");
  return Number.isFinite(value) && value > 0 ? value : 10000;
}

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

async function notifications() {
  const response = await send("/api/notifications");
  assert.equal(response.status, 200, "GET /api/notifications must answer 200");
  assert.ok(Array.isArray(response.body));
  return response.body;
}

async function catalog() {
  const response = await send("/api/products");
  assert.equal(response.status, 200, "GET /api/products must answer 200");
  return response.body;
}

async function firstProductWithStock() {
  const products = await catalog();
  const product = products.find((candidate) => candidate.stock >= 1);
  assert.ok(
    product !== undefined,
    "no product has stock left; reset the stack with: docker compose down -v && docker compose up -d --build",
  );
  return product;
}

async function markerRecords(customerEmail) {
  const records = await notifications();
  return records.filter((record) => record?.payload?.customerEmail === customerEmail);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Wait for the relay to run at least one more pass, then read the notification log again. */
async function afterAnotherRelayPass() {
  await sleep(RELAY_INTERVAL_MS + RELAY_MARGIN_MS);
  return notifications();
}

async function waitForMarker(customerEmail, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let found = [];
  while (Date.now() < deadline) {
    found = await markerRecords(customerEmail);
    if (found.length > 0) {
      return found;
    }
    await sleep(1000);
  }
  throw new Error(
    `no notification for ${customerEmail} appeared within ${timeoutMs} ms (the pending intent was not delivered)`,
  );
}

describe("durability phase selection", () => {
  it("DURABILITY_PHASE names a supported phase", () => {
    assert.ok(
      KNOWN_PHASES.includes(PHASE),
      `DURABILITY_PHASE must be one of ${KNOWN_PHASES.join(", ")} but was "${PHASE}"`,
    );
  });
});

describe("api restart durability (phase: prepare, before `docker compose restart api`)", { skip: PHASE !== "prepare" }, () => {
  it("creates the order that has to survive the api restart", { timeout: 60_000 }, async () => {
    const product = await firstProductWithStock();

    const created = await postJson("/api/orders", {
      productId: product.id,
      quantity: 1,
      customerEmail: API_RESTART_EMAIL,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, "CONFIRMED");

    const records = await markerRecords(API_RESTART_EMAIL);
    assert.equal(records.length, 1, "the pre-restart order must be notified exactly once");
    assert.equal(records[0].orderId, created.body.id);
    assert.equal(records[0].type, "ORDER_CONFIRMATION");
    assert.match(records[0].createdAt, ISO_MILLIS);
  });
});

describe("api restart durability (phase: verify, after `docker compose restart api`)", { skip: PHASE !== "verify" }, () => {
  it("an order created before the api restart is still readable afterwards", { timeout: 60_000 }, async () => {
    const records = await markerRecords(API_RESTART_EMAIL);
    assert.equal(
      records.length,
      1,
      "no pre-restart order found: run the prepare phase before restarting the api (run-acceptance.sh does both)",
    );

    const order = await send(`/api/orders/${records[0].orderId}`);
    assert.equal(order.status, 200, "the order created before the restart must still be readable");
    assert.equal(order.body.id, records[0].orderId);
    assert.equal(order.body.customerEmail, API_RESTART_EMAIL);
    assert.equal(order.body.status, "CONFIRMED");
    assert.equal(order.body.cancelledAt, null);
    assert.equal(order.body.cancellationReason, null);
  });

  it("keeps exactly one ORDER_CONFIRMATION per order across the restart and the relay retries", { timeout: 120_000 }, async () => {
    const before = await notifications();
    assert.ok(before.length > 0, "expected notifications recorded before the restart");

    const after = await afterAnotherRelayPass();

    for (const record of before) {
      const matches = after.filter((candidate) => candidate.orderId === record.orderId);
      assert.equal(
        matches.length,
        1,
        `order ${record.orderId} must keep exactly one ORDER_CONFIRMATION after the restart`,
      );
      assert.deepEqual(matches[0], record, "the stored record must not change after the restart");
    }

    for (const orderId of new Set(after.map((record) => record.orderId))) {
      assert.equal(
        after.filter((record) => record.orderId === orderId).length,
        1,
        `order ${orderId} has more than one ORDER_CONFIRMATION`,
      );
    }
    assert.equal(new Set(after.map((record) => record.id)).size, after.length);
  });

  it("every order recorded before the restart is still readable", { timeout: 60_000 }, async () => {
    const records = await notifications();
    const orderIds = [...new Set(records.map((record) => record.orderId))];
    assert.ok(orderIds.length > 0);

    for (const orderId of orderIds) {
      const response = await send(`/api/orders/${orderId}`);
      assert.equal(response.status, 200, `order ${orderId} must survive the api restart`);
      assert.equal(response.body.id, orderId);
      assert.ok(
        response.body.status === "CONFIRMED" || response.body.status === "SHIPPED",
        `unexpected order status ${String(response.body.status)}`,
      );
      assert.equal(response.body.cancelledAt, null);
      assert.equal(response.body.cancellationReason, null);
    }
  });

  it("post-restart orders are delivered exactly once as well", { timeout: 120_000 }, async () => {
    const product = await firstProductWithStock();
    const created = await postJson("/api/orders", {
      productId: product.id,
      quantity: 1,
      customerEmail: POST_RESTART_EMAIL,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const immediately = await markerRecords(POST_RESTART_EMAIL);
    assert.equal(immediately.length, 1);
    assert.equal(immediately[0].orderId, created.body.id);
    assert.deepEqual(immediately[0].payload, {
      customerEmail: POST_RESTART_EMAIL,
      orderId: created.body.id,
    });

    const later = await afterAnotherRelayPass();
    assert.equal(
      later.filter((record) => record.orderId === created.body.id).length,
      1,
      "a retried relay pass must not append a second notification",
    );

    const order = await send(`/api/orders/${created.body.id}`);
    assert.equal(order.status, 200);
    assert.equal(order.body.customerEmail, POST_RESTART_EMAIL);
  });
});

describe("provider outage durability (phase: pending, provider stopped)", { skip: PHASE !== "pending" }, () => {
  it("answers 500, keeps the order committed and nothing is delivered while the provider is down", { timeout: 120_000 }, async () => {
    const product = await firstProductWithStock();
    const stockBefore = product.stock;

    const created = await postJson("/api/orders", {
      productId: product.id,
      quantity: 1,
      customerEmail: PROVIDER_OUTAGE_EMAIL,
    });

    assert.equal(
      created.status,
      500,
      "with the provider unreachable the preserved post-commit path answers 500",
    );
    assert.equal(typeof created.body?.error, "string");

    const after = await send(`/api/products/${product.id}`);
    assert.equal(after.status, 200);
    assert.equal(
      after.body.stock,
      stockBefore - 1,
      "the order stays committed even though its notification could not be delivered",
    );

    const listing = await send("/api/notifications");
    assert.ok(
      listing.status >= 500,
      "the notification listing depends on the provider, which is stopped",
    );
  });
});

describe("provider outage durability (phase: recovered, provider back up)", { skip: PHASE !== "recovered" }, () => {
  it("the relay delivers the pending intent exactly once and the order is readable", { timeout: 180_000 }, async () => {
    const records = await waitForMarker(PROVIDER_OUTAGE_EMAIL, 60_000);
    assert.equal(
      records.length,
      1,
      "exactly one ORDER_CONFIRMATION may exist for the order created during the outage",
    );

    const [record] = records;
    assert.equal(record.type, "ORDER_CONFIRMATION");
    assert.match(record.createdAt, ISO_MILLIS);
    assert.deepEqual(record.payload, {
      customerEmail: PROVIDER_OUTAGE_EMAIL,
      orderId: record.orderId,
    });

    const order = await send(`/api/orders/${record.orderId}`);
    assert.equal(order.status, 200, "the recovering order must be readable");
    assert.equal(order.body.id, record.orderId);
    assert.equal(order.body.customerEmail, PROVIDER_OUTAGE_EMAIL);
    assert.equal(order.body.status, "CONFIRMED");

    const after = await afterAnotherRelayPass();
    assert.equal(
      after.filter((candidate) => candidate.orderId === record.orderId).length,
      1,
      "retrying the relay pass must not duplicate the recovered notification",
    );
  });
});
