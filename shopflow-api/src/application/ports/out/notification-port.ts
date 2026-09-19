import type {
  NotificationDeliveryRequest,
  NotificationRecord,
} from "../../../domain/notification.js";

/**
 * Outbound port for the notification provider (service owned by shopflow-infra).
 *
 * `submit` is idempotent by `idempotencyKey`: `201` (created) and `200` (already existing for that
 * key) both count as delivered, so retries never create a second record.
 */
export interface NotificationPort {
  submit(notification: NotificationDeliveryRequest): Promise<NotificationRecord>;
  /** All records in insertion (append) order - the source of `GET /api/notifications`. */
  list(): Promise<NotificationRecord[]>;
}
