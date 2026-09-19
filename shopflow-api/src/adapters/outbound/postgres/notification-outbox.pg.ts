import type { Pool, PoolClient } from "pg";
import type {
  NotificationOutbox,
  TransactionalNotificationOutbox,
} from "../../../application/ports/out/notification-outbox.js";
import type {
  NewNotificationIntent,
  NotificationIntent,
} from "../../../domain/notification.js";
import { PENDING_OUTBOX_STATUS, SENT_OUTBOX_STATUS } from "../../../domain/notification.js";
import { mapOutboxRow } from "./row-mappers.js";
import type { OutboxRow } from "./row-mappers.js";

/** Internal outbox store: the durable delivery guarantee for `ORDER_CONFIRMATION` (never exposed by the API). */
export class PgNotificationOutbox implements NotificationOutbox {
  constructor(private readonly pool: Pool) {}

  async listPending(limit: number): Promise<NotificationIntent[]> {
    const result = await this.pool.query<OutboxRow>(
      `SELECT * FROM notification_outbox
       WHERE status = $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [PENDING_OUTBOX_STATUS, limit],
    );
    return result.rows.map(mapOutboxRow);
  }

  async markSent(id: string, sentAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_outbox SET status = $2, sent_at = $3 WHERE id = $1`,
      [id, SENT_OUTBOX_STATUS, sentAt],
    );
  }

  async recordFailure(id: string): Promise<void> {
    await this.pool.query(`UPDATE notification_outbox SET attempts = attempts + 1 WHERE id = $1`, [
      id,
    ]);
  }
}

/** Transaction-scoped intent insert; the unique `(order_id, type)` index keeps it to one per order. */
export class PgTransactionalNotificationOutbox implements TransactionalNotificationOutbox {
  constructor(private readonly client: PoolClient) {}

  async enqueue(intent: NewNotificationIntent): Promise<NotificationIntent> {
    const result = await this.client.query<OutboxRow>(
      `INSERT INTO notification_outbox
        (id, order_id, type, payload, status, attempts, created_at)
       VALUES ($1,$2,$3,$4,$5,0,$6)
       RETURNING *`,
      [
        intent.id,
        intent.orderId,
        intent.type,
        JSON.stringify(intent.payload),
        PENDING_OUTBOX_STATUS,
        intent.createdAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("notification_outbox insert returned no row");
    }
    return mapOutboxRow(row);
  }
}
