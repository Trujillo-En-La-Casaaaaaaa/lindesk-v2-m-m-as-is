import type { NotificationIntent, NotificationRecord } from "../../domain/notification.js";
import { toDeliveryRequest } from "../../domain/notification.js";
import type { Clock } from "../ports/out/clock.js";
import type { NotificationOutbox } from "../ports/out/notification-outbox.js";
import type { NotificationPort } from "../ports/out/notification-port.js";

export type Sleep = (milliseconds: number) => Promise<void>;

/** Backoff between delivery attempts: about 100 ms, then about 300 ms. */
export const DELIVERY_BACKOFF_MS: readonly number[] = [100, 300];

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * Application service that delivers one outbox intent through the notification port and records the
 * outcome. Shared by the create-order use case (in-request delivery before the `201`) and by the
 * outbox relay (background retries), so both paths use the same idempotency key and the same
 * attempt bookkeeping.
 *
 * On success the intent becomes `SENT`. On failure the attempt count is incremented and the intent
 * stays `PENDING`; after the last attempt the delivery error is rethrown so the caller can decide
 * (create-order answers `500` while the order stays committed).
 */
export class NotificationDispatcher {
  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly notifications: NotificationPort,
    private readonly clock: Clock,
    private readonly maxAttempts: number,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  async dispatch(intent: NotificationIntent): Promise<NotificationRecord> {
    let lastError: unknown = new Error(`Notification delivery failed for intent ${intent.id}`);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const record = await this.notifications.submit(toDeliveryRequest(intent));
        await this.outbox.markSent(intent.id, this.clock.nowIso());
        return record;
      } catch (error) {
        lastError = error;
        // Attempt bookkeeping is best effort: a bookkeeping failure must not hide the delivery error.
        try {
          await this.outbox.recordFailure(intent.id);
        } catch {
          // keep the delivery error; the intent stays PENDING and will be retried by the relay
        }
        if (attempt < this.maxAttempts) {
          await this.sleep(DELIVERY_BACKOFF_MS[attempt - 1] ?? 0);
        }
      }
    }

    throw lastError;
  }
}
