/**
 * Notification types. `ORDER_CANCELLATION` is a dormant legacy value kept for data compatibility;
 * this service only ever produces `ORDER_CONFIRMATION`.
 */
export type NotificationType = "ORDER_CONFIRMATION" | "ORDER_CANCELLATION";

/** The only notification this service produces. */
export const ORDER_CONFIRMATION: NotificationType = "ORDER_CONFIRMATION";

/** Free-form payload; the preserved order-confirmation payload carries `customerEmail` + `orderId`. */
export type NotificationPayload = Record<string, unknown>;

/**
 * Record shape returned by the notification provider and by `GET /api/notifications`.
 * `payload.orderId` intentionally duplicates the top-level `orderId` (legacy behaviour).
 */
export interface NotificationRecord {
  id: string;
  type: NotificationType;
  orderId: string;
  createdAt: string;
  payload: NotificationPayload;
}

/**
 * A submission to the notification provider. `idempotencyKey` is the outbox row id, so retries and
 * restarts deliver exactly one `ORDER_CONFIRMATION` per order.
 */
export interface NotificationDeliveryRequest {
  idempotencyKey: string;
  type: NotificationType;
  orderId: string;
  payload: NotificationPayload;
}

/** Outbox lifecycle states written to `notification_outbox.status`. */
export type OutboxStatus = "PENDING" | "SENT";

export const PENDING_OUTBOX_STATUS: OutboxStatus = "PENDING";
export const SENT_OUTBOX_STATUS: OutboxStatus = "SENT";

/**
 * A durable delivery intent for one order and notification type
 * (internal table `notification_outbox`, never exposed through the HTTP API).
 */
export interface NotificationIntent {
  id: string;
  orderId: string;
  type: NotificationType;
  payload: NotificationPayload;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

/** A new intent, staged inside the order transaction before it is committed. */
export interface NewNotificationIntent {
  id: string;
  orderId: string;
  type: NotificationType;
  payload: NotificationPayload;
  createdAt: string;
}

/** Preserved order-confirmation payload: the duplicated `orderId` is intentional. */
export function orderConfirmationPayload(orderId: string, customerEmail: string): NotificationPayload {
  return { customerEmail, orderId };
}

/** Project a stored intent onto the provider request, reusing the intent id as idempotency key. */
export function toDeliveryRequest(intent: NotificationIntent): NotificationDeliveryRequest {
  return {
    idempotencyKey: intent.id,
    type: intent.type,
    orderId: intent.orderId,
    payload: intent.payload,
  };
}
