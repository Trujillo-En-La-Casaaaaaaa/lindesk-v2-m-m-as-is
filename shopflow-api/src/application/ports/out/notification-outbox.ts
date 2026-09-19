import type {
  NewNotificationIntent,
  NotificationIntent,
} from "../../../domain/notification.js";

/**
 * Write side of the internal `notification_outbox` table - the durable delivery intent store that
 * guarantees exactly one `ORDER_CONFIRMATION` per order across retries, provider restarts and API
 * restarts. Intents are never deleted.
 */
export interface NotificationOutbox {
  /** `PENDING` intents, oldest first (the relay's work list). */
  listPending(limit: number): Promise<NotificationIntent[]>;
  /** Mark an intent delivered (`status='SENT'`, `sent_at` set). */
  markSent(id: string, sentAt: string): Promise<void>;
  /** Count one failed delivery attempt (`attempts = attempts + 1`); the row stays `PENDING`. */
  recordFailure(id: string): Promise<void>;
}

/** Outbox staging that participates in the order transaction. */
export interface TransactionalNotificationOutbox {
  /**
   * Stage exactly one intent (status `PENDING`, unique per `(order_id, type)`) inside the order
   * transaction, so a committed order always has its delivery intent committed with it.
   */
  enqueue(intent: NewNotificationIntent): Promise<NotificationIntent>;
}
