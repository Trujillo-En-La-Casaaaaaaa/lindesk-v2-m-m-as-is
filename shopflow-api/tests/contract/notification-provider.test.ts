import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { request, resolveApiBaseUrl, resolveProviderUrl } from "../support/http-server.js";

/**
 * Contract of the notification provider owned by shopflow-infra, exercised over HTTP against the
 * composed/emulated service (`PROVIDER_URL`).
 *
 * The provider is the external system that keeps the delivery guarantee: `POST /notifications` is
 * idempotent by `idempotencyKey`, `201` and `200` both count as delivered, and `GET /notifications`
 * returns the records in append order - which is exactly what `GET /api/notifications` reproduces.
 */
const providerUrl = resolveProviderUrl();
const apiBaseUrl = resolveApiBaseUrl();

if (providerUrl === null) {
  console.warn(
    "[skip] notification provider contract suite skipped: provide PROVIDER_URL (for example http://127.0.0.1:4010)",
  );
}

const describeProvider = describe.skipIf(providerUrl === null);
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_KEYS = ["createdAt", "id", "orderId", "payload", "type"];

interface ProviderRecord {
  id: string;
  type: string;
  orderId: string;
  createdAt: string;
  payload: { customerEmail?: string; orderId?: string };
}

async function submit(body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${providerUrl}/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function allRecords(): Promise<ProviderRecord[]> {
  const response = await fetch(`${providerUrl}/notifications`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as unknown;
  expect(Array.isArray(body)).toBe(true);
  return body as ProviderRecord[];
}

describeProvider("notification provider contract", () => {
  it('GET /health answers 200 {"ok":true}', async () => {
    const response = await fetch(`${providerUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns a 201 record with the exact shape on the first submission", async () => {
    const orderId = randomUUID();
    const idempotencyKey = randomUUID();

    const created = await submit({
      idempotencyKey,
      type: "ORDER_CONFIRMATION",
      orderId,
      payload: { customerEmail: "provider-contract@example.com", orderId },
    });

    expect(created.status).toBe(201);
    const record = created.body as ProviderRecord;
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
    expect(record.type).toBe("ORDER_CONFIRMATION");
    expect(record.orderId).toBe(orderId);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.createdAt).toMatch(ISO_MILLIS);
    expect(record.payload).toEqual({
      customerEmail: "provider-contract@example.com",
      orderId,
    });
    expect(record).not.toHaveProperty("idempotencyKey");

    const records = await allRecords();
    expect(records.filter((candidate) => candidate.orderId === orderId)).toEqual([record]);
  });

  it("answers 200 with the existing record for a repeated idempotency key and appends nothing", async () => {
    const orderId = randomUUID();
    const idempotencyKey = randomUUID();
    const body = {
      idempotencyKey,
      type: "ORDER_CONFIRMATION",
      orderId,
      payload: { customerEmail: "duplicate@example.com", orderId },
    };

    const first = await submit(body);
    const second = await submit(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const records = await allRecords();
    expect(records.filter((candidate) => candidate.orderId === orderId)).toHaveLength(1);
  });

  it("records a new entry for the same order only when the key changes (caller owns one key per intent)", async () => {
    const orderId = randomUUID();
    const payload = { customerEmail: "distinct-keys@example.com", orderId };

    const first = await submit({
      idempotencyKey: randomUUID(),
      type: "ORDER_CONFIRMATION",
      orderId,
      payload,
    });
    const second = await submit({
      idempotencyKey: randomUUID(),
      type: "ORDER_CONFIRMATION",
      orderId,
      payload,
    });

    expect([first.status, second.status]).toEqual([201, 201]);
    expect((first.body as ProviderRecord).id).not.toBe((second.body as ProviderRecord).id);
    expect((await allRecords()).filter((candidate) => candidate.orderId === orderId)).toHaveLength(2);
  });

  it("rejects an invalid payload with 400 Invalid notification and appends nothing", async () => {
    const before = (await allRecords()).length;

    for (const invalid of [
      { type: "ORDER_CONFIRMATION", orderId: randomUUID(), payload: {} },
      { idempotencyKey: randomUUID(), type: "ORDER_CONFIRMATION", payload: {} },
      { idempotencyKey: randomUUID(), orderId: randomUUID(), payload: {} },
      { idempotencyKey: randomUUID(), type: "ORDER_CANCELLATION", orderId: randomUUID(), payload: {} },
    ]) {
      expect(await submit(invalid)).toMatchObject({
        status: 400,
        body: { error: "Invalid notification" },
      });
    }

    expect((await allRecords()).length).toBe(before);
  });

  it("returns records in append order", async () => {
    const firstOrderId = randomUUID();
    const secondOrderId = randomUUID();

    await submit({
      idempotencyKey: randomUUID(),
      type: "ORDER_CONFIRMATION",
      orderId: firstOrderId,
      payload: { customerEmail: "append-first@example.com", orderId: firstOrderId },
    });
    await submit({
      idempotencyKey: randomUUID(),
      type: "ORDER_CONFIRMATION",
      orderId: secondOrderId,
      payload: { customerEmail: "append-second@example.com", orderId: secondOrderId },
    });

    const records = await allRecords();
    const firstIndex = records.findIndex((record) => record.orderId === firstOrderId);
    const secondIndex = records.findIndex((record) => record.orderId === secondOrderId);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });
});

const describeAgainstApi = describe.skipIf(providerUrl === null || apiBaseUrl === null);

if (providerUrl !== null && apiBaseUrl === null) {
  console.warn(
    "[skip] api<->provider agreement check skipped: provide BASE_URL/API_BASE_URL (for example http://127.0.0.1:3001)",
  );
}

describeAgainstApi("api <-> provider agreement", () => {
  it("stores the API's order confirmation with the same record the provider returns", async (ctx) => {
    const catalog = await request(apiBaseUrl as string, "/api/products");
    const products = (catalog.body ?? []) as { id: string; stock: number }[];
    const product = products.find((candidate) => candidate.stock >= 1);
    if (product === undefined) {
      console.warn(
        "[skip] api<->provider agreement check needs catalog stock; reset the stack (docker compose down -v)",
      );
      ctx.skip();
    }

    const created = await fetch(`${apiBaseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        quantity: 1,
        customerEmail: "agreement@example.com",
      }),
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { id: string };

    const apiNotifications = await request(apiBaseUrl as string, "/api/notifications");
    expect(apiNotifications.status).toBe(200);
    const apiRecords = (apiNotifications.body as ProviderRecord[]).filter(
      (record) => record.orderId === order.id,
    );
    expect(apiRecords).toHaveLength(1);

    const providerRecords = (await allRecords()).filter((record) => record.orderId === order.id);
    expect(providerRecords).toHaveLength(1);
    expect(apiRecords[0]).toEqual(providerRecords[0]);
    expect(apiRecords[0]?.payload).toEqual({
      customerEmail: "agreement@example.com",
      orderId: order.id,
    });
  });
});
