import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxRelay } from "../../src/adapters/outbound/outbox/outbox.relay.js";
import { FakeNotificationPort, FixedClock } from "../support/fakes.js";
import {
  DATABASE_SKIP_MESSAGE,
  TestDatabase,
  resolveTestDatabaseUrl,
} from "../support/database.js";
import { createPostgresHarness, uniqueId } from "../support/postgres-harness.js";
import type { PostgresHarness } from "../support/postgres-harness.js";

const databaseUrl = resolveTestDatabaseUrl();
if (databaseUrl === null) {
  console.warn(DATABASE_SKIP_MESSAGE);
}
const describeWithDatabase = describe.skipIf(databaseUrl === null);

const product = { id: uniqueId("it-outbox"), name: "Outbox Product", priceCents: 1999, stock: 10 };
const customerEmail = "outbox@example.com";

interface LogLine {
  level: string;
  message: string;
}

function recordingLogger(lines: LogLine[]) {
  return {
    info: (message: string) => lines.push({ level: "info", message }),
    error: (message: string) => lines.push({ level: "error", message }),
  };
}

describeWithDatabase("notification durability and outbox recovery", () => {
  let database: TestDatabase;
  let provider: FakeNotificationPort;

  beforeAll(async () => {
    database = await TestDatabase.open(databaseUrl as string);
  });

  beforeEach(async () => {
    await database.removeTestData([product.id]);
    await database.insertProduct(product);
    provider = new FakeNotificationPort(new FixedClock());
  });

  afterAll(async () => {
    await database.removeTestData([product.id]);
    await database.close();
  });

  function harness(retryAttempts = 3): PostgresHarness {
    return createPostgresHarness(database.pool, { notifications: provider, retryAttempts });
  }

  it("keeps the order committed and the intent PENDING when the provider is unavailable, then recovers", async () => {
    const api = harness(3);
    provider.failuresRemaining = Number.POSITIVE_INFINITY;

    await expect(
      api.useCases.createOrder.execute({ productId: product.id, quantity: 2, customerEmail }),
    ).rejects.toThrow("notification provider unavailable");

    // The order and the stock change are committed (legacy post-commit failure semantics) ...
    const orders = await database.readOrdersForProduct(product.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe("CONFIRMED");
    expect((await database.readProduct(product.id))?.stock).toBe(8);

    // ... and the delivery intent survives as PENDING with the failed attempt count.
    const orderId = orders[0]?.id as string;
    const pendingIntents = await database.readOutboxForOrder(orderId);
    expect(pendingIntents).toHaveLength(1);
    expect(pendingIntents[0]).toMatchObject({
      type: "ORDER_CONFIRMATION",
      status: "PENDING",
      attempts: 3,
      payload: { customerEmail, orderId },
      sent_at: null,
    });
    expect(provider.records).toHaveLength(0);

    // The provider recovers: a relay pass retries the same idempotency key and marks the intent SENT.
    provider.failuresRemaining = 0;
    const logLines: LogLine[] = [];
    const relay = new OutboxRelay(api.useCases.deliverPendingNotifications, 60_000, recordingLogger(logLines));
    const outcome = await relay.runOnce();

    // The relay works on the shared outbox table, so scope every assertion to this order's intent.
    expect(outcome?.delivered).toContain(pendingIntents[0]?.id);
    expect(outcome?.failed).toEqual([]);
    expect(logLines.some((line) => line.level === "info")).toBe(true);

    const deliveredIntents = await database.readOutboxForOrder(orderId);
    expect(deliveredIntents).toHaveLength(1);
    expect(deliveredIntents[0]?.status).toBe("SENT");
    expect(deliveredIntents[0]?.sent_at).not.toBeNull();

    const records = provider.recordsFor(orderId);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      id: records[0]?.id,
      type: "ORDER_CONFIRMATION",
      orderId,
      createdAt: "2026-09-17T10:15:00.000Z",
      payload: { customerEmail, orderId },
    });
    const submittedKeys = provider.submissions
      .filter((submission) => submission.orderId === orderId)
      .map((submission) => submission.idempotencyKey);
    expect(new Set(submittedKeys)).toEqual(new Set([pendingIntents[0]?.id]));
  });

  it("creates no duplicate record when the relay restarts and picks the same intent up again", async () => {
    const api = harness(1);
    const order = await api.useCases.createOrder.execute({
      productId: product.id,
      quantity: 1,
      customerEmail,
    });
    const intents = await database.readOutboxForOrder(order.id);
    expect(intents[0]?.status).toBe("SENT");
    expect(provider.recordsFor(order.id)).toHaveLength(1);

    // Crash window: the provider already stored the record but the API restarted before it could mark
    // the intent SENT. The intent is PENDING again, so the relay retries it after the restart.
    await database.forcePending(intents[0]?.id as string);

    const restartedApi = harness(1); // fresh adapters = restarted process
    const logLines: LogLine[] = [];
    const relay = new OutboxRelay(
      restartedApi.useCases.deliverPendingNotifications,
      60_000,
      recordingLogger(logLines),
    );
    const outcome = await relay.runOnce();

    expect(outcome?.delivered).toContain(intents[0]?.id);
    expect(provider.recordsFor(order.id)).toHaveLength(1);
    const submissionKeys = provider.submissions
      .filter((submission) => submission.orderId === order.id)
      .map((submission) => submission.idempotencyKey);
    expect(submissionKeys).toEqual([intents[0]?.id, intents[0]?.id]);
    expect((await database.readOutboxForOrder(order.id))[0]?.status).toBe("SENT");

    // A later pass has nothing to do and still cannot duplicate anything.
    const idleRun = await relay.runOnce();
    expect(idleRun?.delivered ?? []).not.toContain(intents[0]?.id);
    expect(provider.recordsFor(order.id)).toHaveLength(1);
    expect(await database.readOutboxForOrder(order.id)).toHaveLength(1);
  });

  it("delivers notifications for several pending orders in one pass and never deletes intents", async () => {
    const api = harness(3);
    provider.failuresRemaining = Number.POSITIVE_INFINITY;
    const first = await api.useCases.createOrder
      .execute({ productId: product.id, quantity: 1, customerEmail: "first@example.com" })
      .catch(() => null);
    const second = await api.useCases.createOrder
      .execute({ productId: product.id, quantity: 1, customerEmail: "second@example.com" })
      .catch(() => null);
    expect(first).toBeNull();
    expect(second).toBeNull();

    const orders = await database.readOrdersForProduct(product.id);
    expect(orders).toHaveLength(2);

    const myIntentIds = (
      await Promise.all(orders.map((order) => database.readOutboxForOrder(order.id)))
    ).flatMap((intents) => intents.map((intent) => intent.id));
    expect(myIntentIds).toHaveLength(2);

    provider.failuresRemaining = 0;
    const outcome = await api.useCases.deliverPendingNotifications.execute();

    expect(outcome.failed).toEqual([]);
    expect(outcome.delivered).toEqual(expect.arrayContaining(myIntentIds));
    for (const order of orders) {
      const intents = await database.readOutboxForOrder(order.id);
      expect(intents).toHaveLength(1);
      expect(intents[0]?.status).toBe("SENT");
    }
    const myRecords = provider.records.filter((record) =>
      orders.some((order) => order.id === record.orderId),
    );
    expect(myRecords).toHaveLength(2);
    expect(myRecords.map((record) => record.payload.customerEmail).sort()).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
  });

  it("leaves the intent PENDING and logs when the relay pass cannot reach the provider", async () => {
    const api = harness(1);
    provider.failuresRemaining = Number.POSITIVE_INFINITY;
    await api.useCases.createOrder
      .execute({ productId: product.id, quantity: 1, customerEmail })
      .catch(() => null);
    const orderId = (await database.readOrdersForProduct(product.id))[0]?.id as string;

    const pendingIntentId = (await database.readOutboxForOrder(orderId))[0]?.id as string;
    const logLines: LogLine[] = [];
    const relay = new OutboxRelay(api.useCases.deliverPendingNotifications, 60_000, recordingLogger(logLines));
    const outcome = await relay.runOnce();

    expect(outcome?.failed).toContain(pendingIntentId);
    expect(logLines.some((line) => line.level === "error")).toBe(true);

    const stillPending = await database.readOutboxForOrder(orderId);
    expect(stillPending[0]?.status).toBe("PENDING");
    expect(stillPending[0]?.attempts).toBeGreaterThan(1);
    expect(provider.recordsFor(orderId)).toHaveLength(0);
  });

  it("marks an intent SENT from the startup pass of the relay", async () => {
    const api = harness(3);
    provider.failuresRemaining = Number.POSITIVE_INFINITY;
    await api.useCases.createOrder
      .execute({ productId: product.id, quantity: 1, customerEmail })
      .catch(() => null);
    const orderId = (await database.readOrdersForProduct(product.id))[0]?.id as string;
    provider.failuresRemaining = 0;

    const relay = new OutboxRelay(api.useCases.deliverPendingNotifications, 60_000, recordingLogger([]));
    relay.start();
    // The first pass is asynchronous; poll the outbox until it flips to SENT.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const intents = await database.readOutboxForOrder(orderId);
      if (intents[0]?.status === "SENT") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await relay.stop();

    expect((await database.readOutboxForOrder(orderId))[0]?.status).toBe("SENT");
    expect(provider.recordsFor(orderId)).toHaveLength(1);
  });
});
