import { describe, expect, it } from "vitest";
import type { NotificationIntent } from "../../../src/domain/notification.js";
import { NotificationDispatcher } from "../../../src/application/use-cases/notification-dispatcher.js";
import { DeliverPendingNotifications } from "../../../src/application/use-cases/deliver-pending-notifications.use-case.js";
import {
  FakeNotificationPort,
  FixedClock,
  InMemoryNotificationOutbox,
  InMemoryStore,
  sampleIntent,
} from "../../support/fakes.js";

function buildPendingDelivery(
  intents: NotificationIntent[] = [],
  maxAttempts = 3,
  batchSize = 50,
) {
  const store = new InMemoryStore([], [], intents);
  const clock = new FixedClock();
  const outbox = new InMemoryNotificationOutbox(store);
  const notifications = new FakeNotificationPort(clock);
  const dispatcher = new NotificationDispatcher(outbox, notifications, clock, maxAttempts, async () => {});
  const deliverPending = new DeliverPendingNotifications(outbox, dispatcher, batchSize);
  return { store, outbox, notifications, deliverPending };
}

describe("DeliverPendingNotifications use case (outbox relay pass)", () => {
  it("does nothing when there is no pending intent", async () => {
    const { deliverPending, notifications } = buildPendingDelivery();

    await expect(deliverPending.execute()).resolves.toEqual({ delivered: [], failed: [] });
    expect(notifications.submissions).toHaveLength(0);
  });

  it("delivers pending intents with their idempotency key and marks them SENT", async () => {
    const { deliverPending, notifications, store } = buildPendingDelivery([
      sampleIntent({ id: "intent-1", orderId: "order-1" }),
      sampleIntent({
        id: "intent-2",
        orderId: "order-2",
        createdAt: "2026-09-17T10:16:00.000Z",
        payload: { customerEmail: "second@example.com", orderId: "order-2" },
      }),
    ]);

    const outcome = await deliverPending.execute();

    expect(outcome).toEqual({ delivered: ["intent-1", "intent-2"], failed: [] });
    expect(notifications.submissions.map((submission) => submission.idempotencyKey)).toEqual([
      "intent-1",
      "intent-2",
    ]);
    expect(notifications.records).toHaveLength(2);
    expect(store.intents.map((intent) => intent.status)).toEqual(["SENT", "SENT"]);
    expect(store.intents.map((intent) => intent.sentAt)).toEqual([
      "2026-09-17T10:15:00.000Z",
      "2026-09-17T10:15:00.000Z",
    ]);
  });

  it("keeps a failed intent PENDING with its attempt count and still delivers the others", async () => {
    const { deliverPending, notifications, store } = buildPendingDelivery([
      sampleIntent({ id: "intent-1", orderId: "order-1" }),
      sampleIntent({ id: "intent-2", orderId: "order-2" }),
    ]);
    // Every attempt for the first intent fails, the second succeeds.
    const originalSubmit = notifications.submit.bind(notifications);
    notifications.submit = async (submission) => {
      if (submission.idempotencyKey === "intent-1") {
        throw new Error("provider down");
      }
      return originalSubmit(submission);
    };

    const outcome = await deliverPending.execute();

    expect(outcome).toEqual({ delivered: ["intent-2"], failed: ["intent-1"] });
    const first = store.intents.find((intent) => intent.id === "intent-1");
    const second = store.intents.find((intent) => intent.id === "intent-2");
    expect(first?.status).toBe("PENDING");
    expect(first?.attempts).toBe(3);
    expect(second?.status).toBe("SENT");
    expect(notifications.records).toHaveLength(1);
  });

  it("creates no duplicate record when a relay pass is re-run (restart-style retry)", async () => {
    const { deliverPending, notifications, store } = buildPendingDelivery([
      sampleIntent({ id: "intent-1", orderId: "order-1" }),
    ]);

    await deliverPending.execute();
    const secondRun = await deliverPending.execute();

    expect(secondRun).toEqual({ delivered: [], failed: [] });
    expect(notifications.records).toHaveLength(1);
    expect(notifications.submissions).toHaveLength(1);
    expect(store.intents).toHaveLength(1);
    expect(store.intents[0]?.status).toBe("SENT");
  });

  it("retries a previously failed intent with the same idempotency key without duplicating the record", async () => {
    const { deliverPending, notifications, store } = buildPendingDelivery([
      sampleIntent({ id: "intent-1", orderId: "order-1" }),
    ]);
    notifications.failuresRemaining = 3;

    const firstRun = await deliverPending.execute();
    expect(firstRun.failed).toEqual(["intent-1"]);
    expect(store.intents[0]?.attempts).toBe(3);

    // The provider recovers: the same key is submitted again.
    const secondRun = await deliverPending.execute();
    expect(secondRun.delivered).toEqual(["intent-1"]);
    expect(notifications.records).toHaveLength(1);
    expect(notifications.submissions.map((submission) => submission.idempotencyKey)).toEqual([
      "intent-1",
      "intent-1",
      "intent-1",
      "intent-1",
    ]);
    expect(store.intents[0]?.status).toBe("SENT");
  });

  it("processes at most one batch per pass", async () => {
    const { deliverPending, notifications } = buildPendingDelivery(
      [
        sampleIntent({ id: "intent-1", orderId: "order-1" }),
        sampleIntent({ id: "intent-2", orderId: "order-2" }),
      ],
      3,
      1,
    );

    await expect(deliverPending.execute()).resolves.toEqual({
      delivered: ["intent-1"],
      failed: [],
    });
    expect(notifications.records).toHaveLength(1);
  });
});
