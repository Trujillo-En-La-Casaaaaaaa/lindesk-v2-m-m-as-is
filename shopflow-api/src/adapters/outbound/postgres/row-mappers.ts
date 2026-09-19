import type {
  NotificationIntent,
  NotificationPayload,
  NotificationType,
  OutboxStatus,
} from "../../../domain/notification.js";
import type { Order } from "../../../domain/order.js";
import type { OrderStatus } from "../../../domain/order-status.js";
import type { Product } from "../../../domain/product.js";

/** Row shapes as returned by `pg` (snake_case columns of the schema owned by shopflow-infra). */

export interface ProductRow {
  id: string;
  name: string;
  price_cents: number | string;
  stock: number | string;
}

export interface OrderRow {
  id: string;
  customer_email: string;
  status: string;
  product_id: string;
  quantity: number | string;
  total_cents: number | string;
  created_at: Date | string;
  cancelled_at: Date | string | null;
  cancellation_reason: string | null;
}

export interface OutboxRow {
  id: string;
  order_id: string;
  type: string;
  payload: NotificationPayload | string | null;
  status: string;
  attempts: number | string;
  created_at: Date | string;
  sent_at: Date | string | null;
}

export function mapProductRow(row: ProductRow): Product {
  return {
    id: String(row.id),
    name: String(row.name),
    priceCents: Number(row.price_cents),
    stock: Number(row.stock),
  };
}

/**
 * Row mapping preserved from the monolith: `created_at` becomes an ISO-8601 string and the dormant
 * cancellation columns are always present, mapped to `null` when unset.
 */
export function mapOrderRow(row: OrderRow): Order {
  return {
    id: String(row.id),
    customerEmail: String(row.customer_email),
    status: row.status as OrderStatus,
    productId: String(row.product_id),
    quantity: Number(row.quantity),
    totalCents: Number(row.total_cents),
    createdAt: new Date(String(row.created_at)).toISOString(),
    cancelledAt: row.cancelled_at ? new Date(String(row.cancelled_at)).toISOString() : null,
    cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : null,
  };
}

export function mapOutboxRow(row: OutboxRow): NotificationIntent {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    type: row.type as NotificationType,
    payload: mapPayload(row.payload),
    status: row.status as OutboxStatus,
    attempts: Number(row.attempts),
    createdAt: new Date(String(row.created_at)).toISOString(),
    sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
  };
}

function mapPayload(payload: NotificationPayload | string | null): NotificationPayload {
  if (payload === null || payload === undefined) {
    return {};
  }
  if (typeof payload === "string") {
    return JSON.parse(payload) as NotificationPayload;
  }
  return payload;
}
